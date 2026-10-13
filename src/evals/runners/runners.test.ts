import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { RunnerError } from '../../errors.ts';
import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import {
  buildAgyGraderArgs,
  buildAgyTaskArgs,
  buildClaudeGraderArgs,
  buildClaudeTaskArgs,
  buildCodexGraderArgs,
  buildCodexTaskArgs,
  buildGeminiGraderArgs,
  buildGeminiTaskArgs,
  createEvalRunner,
  detectDefaultRunner,
  parseAgyGraderJson,
  parseAgyStreamJson,
  parseClaudeStreamJson,
  parseCodexStreamJson,
  parseGeminiStreamJson,
} from './index.ts';

test('buildAgyTaskArgs and buildAgyGraderArgs keep -p=<prompt> last and omit --mode auto', () => {
  const prompt = 'Refactor config';
  const graderPrompt = 'Grade assertions';

  const taskArgs = buildAgyTaskArgs({
    prompt,
    timeoutSeconds: 600,
    sandbox: true,
    extraArgs: ['--verbose'],
  });
  const graderArgs = buildAgyGraderArgs({
    prompt: graderPrompt,
    schemaPath: '/tmp/grader-schema.json',
    timeoutSeconds: 120,
    extraArgs: ['--verbose'],
  });

  assert.deepEqual(taskArgs, [
    '--dangerously-skip-permissions',
    '--print-timeout=600s',
    '--output-format=stream-json',
    '--sandbox',
    '--verbose',
    '-p=Refactor config',
  ]);
  assert.equal(taskArgs.includes('--mode'), false);
  assert.deepEqual(graderArgs, [
    '--dangerously-skip-permissions',
    '--print-timeout=120s',
    '--output-format=json',
    '--json-schema=/tmp/grader-schema.json',
    '--verbose',
    '-p=Grade assertions',
  ]);
});

test('parseAgyStreamJson detects view_file and run_command SKILL.md triggers and extracts result', () => {
  const viewFileStream = [
    JSON.stringify({
      event: 'step_update',
      step_update: {
        tool_name: 'view_file',
        tool_info: {
          parameters: {
            AbsolutePath: '/tmp/work/.agents/skills/demo-skill/SKILL.md',
          },
        },
      },
    }),
    JSON.stringify({
      event: 'result',
      result: {
        response: 'Done with view_file',
        duration_ms: 4200,
        usage: { input_tokens: 300, output_tokens: 150, total_tokens: 450 },
      },
    }),
  ].join('\n');
  const commandStream = [
    JSON.stringify({
      type: 'step_update',
      tool_name: 'run_command',
      tool_info: {
        parameters: {
          CommandLine: 'cat .agents/skills/demo-skill/SKILL.md',
        },
      },
    }),
    JSON.stringify({
      type: 'result',
      response: 'Done with command',
      duration_seconds: 2.5,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  ].join('\n');
  const nonTriggerStream = [
    JSON.stringify({
      type: 'step_update',
      tool_name: 'view_file',
      tool_info: {
        parameters: {
          AbsolutePath: '/tmp/work/README.md',
        },
      },
    }),
    JSON.stringify({
      type: 'result',
      response: 'No skill read',
      duration_ms: 1000,
      usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 },
    }),
  ].join('\n');

  const parsedView = parseAgyStreamJson({
    stdout: viewFileStream,
    skillName: 'demo-skill',
  });
  const parsedCommand = parseAgyStreamJson({
    stdout: commandStream,
    skillName: 'demo-skill',
  });
  const parsedNonTrigger = parseAgyStreamJson({
    stdout: nonTriggerStream,
    skillName: 'demo-skill',
  });

  assert.equal(parsedView.triggered, true);
  assert.equal(parsedView.response, 'Done with view_file');
  assert.equal(parsedView.durationMs, 4200);
  assert.deepEqual(parsedView.usage, {
    input_tokens: 300,
    output_tokens: 150,
    total_tokens: 450,
  });
  assert.equal(parsedCommand.triggered, true);
  assert.equal(parsedCommand.durationMs, 2500);
  assert.equal(parsedNonTrigger.triggered, false);
});

test('parseAgyGraderJson prefers structured_output and falls back to response JSON', () => {
  const withStructured = JSON.stringify({
    type: 'result',
    structured_output: {
      results: [{ assertion: 'A', passed: true, evidence: 'Found A' }],
    },
    response: 'ignored text',
    duration_ms: 800,
    usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
  });
  const withResponseFallback = JSON.stringify({
    type: 'result',
    response: JSON.stringify({
      results: [{ assertion: 'B', passed: false, evidence: 'Missing B' }],
    }),
    duration_ms: 900,
    usage: { input_tokens: 45, output_tokens: 25, total_tokens: 70 },
  });

  const first = parseAgyGraderJson({ stdout: withStructured });
  const second = parseAgyGraderJson({ stdout: withResponseFallback });

  assert.deepEqual(first.output, {
    results: [{ assertion: 'A', passed: true, evidence: 'Found A' }],
  });
  assert.deepEqual(second.output, {
    results: [{ assertion: 'B', passed: false, evidence: 'Missing B' }],
  });
});

test('claude, codex, and gemini builders and stream parsers detect triggers and extract responses', () => {
  const claudeStdout = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Skill',
            input: { skill: 'demo-skill' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      result: 'Claude output',
      duration_ms: 1500,
      usage: { input_tokens: 200, output_tokens: 100 },
    }),
  ].join('\n');
  const codexStdout = [
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'cat .agents/skills/demo-skill/SKILL.md',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Codex output' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 150, output_tokens: 75 },
    }),
  ].join('\n');
  const geminiStdout = [
    JSON.stringify({
      type: 'tool_use',
      tool_name: 'activate_skill',
      parameters: { name: 'demo-skill' },
    }),
    JSON.stringify({
      type: 'result',
      response: 'Gemini output',
      duration_ms: 1300,
      usage: { input_tokens: 180, output_tokens: 90, total_tokens: 270 },
    }),
  ].join('\n');

  const claudeArgs = buildClaudeTaskArgs({
    prompt: 'Hello',
    skillName: 'demo-skill',
    excludeSkill: true,
  });
  const claudeGrader = buildClaudeGraderArgs({
    prompt: 'Grade',
    schema: { type: 'object' },
  });
  const codexArgs = buildCodexTaskArgs('Run codex');
  const codexGrader = buildCodexGraderArgs({
    prompt: 'Grade codex',
    schemaPath: '/tmp/schema.json',
  });
  const geminiArgs = buildGeminiTaskArgs({
    prompt: 'Run gemini',
    sandbox: true,
  });
  const geminiGrader = buildGeminiGraderArgs('Grade gemini');
  const claudeParsed = parseClaudeStreamJson({
    stdout: claudeStdout,
    skillName: 'demo-skill',
  });
  const codexParsed = parseCodexStreamJson({
    stdout: codexStdout,
    skillName: 'demo-skill',
    fallbackDurationMs: 1100,
  });
  const geminiParsed = parseGeminiStreamJson({
    stdout: geminiStdout,
    skillName: 'demo-skill',
  });

  assert.ok(claudeArgs.includes('--disallowedTools'));
  assert.ok(claudeGrader.includes('--json-schema'));
  assert.equal(codexArgs[0], 'exec');
  assert.ok(codexGrader.includes('--output-schema'));
  assert.ok(geminiArgs.includes('--approval-mode=yolo'));
  assert.ok(geminiGrader.includes('json'));
  assert.equal(claudeParsed.triggered, true);
  assert.equal(claudeParsed.response, 'Claude output');
  assert.equal(codexParsed.triggered, true);
  assert.equal(codexParsed.response, 'Codex output');
  assert.equal(geminiParsed.triggered, true);
  assert.equal(geminiParsed.response, 'Gemini output');
});

test('stream parsers throw RunnerError when final result event is missing', () => {
  const truncatedStream = JSON.stringify({
    type: 'step_update',
    tool_name: 'view_file',
  });

  const parseTruncated = () => ({
    agy: () =>
      parseAgyStreamJson({ stdout: truncatedStream, skillName: 'demo-skill' }),
    claude: () =>
      parseClaudeStreamJson({
        stdout: truncatedStream,
        skillName: 'demo-skill',
      }),
    codex: () =>
      parseCodexStreamJson({
        stdout: truncatedStream,
        skillName: 'demo-skill',
      }),
    gemini: () =>
      parseGeminiStreamJson({
        stdout: truncatedStream,
        skillName: 'demo-skill',
      }),
  });
  const actions = parseTruncated();

  assert.throws(actions.agy, RunnerError);
  assert.throws(actions.claude, RunnerError);
  assert.throws(actions.codex, RunnerError);
  assert.throws(actions.gemini, RunnerError);
});

test('detectDefaultRunner prioritizes agy -> claude -> codex -> gemini and agy runner executes binary', async (t) => {
  const root = await tempDir(t);
  const binDir = join(root, 'bin');
  const stubAgy = join(binDir, 'agy');
  const runDir = join(root, 'run');
  await writeFiles(binDir, {
    claude: '#!/bin/sh\nexit 0\n',
    agy: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "step_update", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "/work/.agents/skills/demo-skill/SKILL.md" } } }));',
      'console.log(JSON.stringify({ type: "result", response: "stub response", duration_ms: 321, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));',
      '',
    ].join('\n'),
  });
  await chmod(join(binDir, 'claude'), 0o755);
  await chmod(stubAgy, 0o755);

  const detected = await detectDefaultRunner({ searchPath: [binDir] });
  const runner = createEvalRunner({
    runner: 'agy',
    binary: stubAgy,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  const taskResult = await runner.runTask({
    prompt: 'Hello agy',
    workdir: root,
    runDir,
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  const loggedStdout = await readFile(join(runDir, 'stdout.log'), 'utf8');

  assert.equal(detected, 'agy');
  assert.equal(taskResult.triggered, true);
  assert.equal(taskResult.response, 'stub response');
  assert.equal(taskResult.durationMs, 321);
  assert.match(loggedStdout, /stub response/);
});
