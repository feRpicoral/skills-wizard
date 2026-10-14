import assert from 'node:assert/strict';
import { chmod, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { RunnerError } from '../../errors.ts';
import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import { createAgyRunner } from './agy.ts';
import {
  buildAgyGraderArgs,
  buildAgyTaskArgs,
  createEvalRunner,
  detectDefaultRunner,
  mentionsSkillFile,
  normalizeUsage,
  parseAgyGraderJson,
  parseAgyStreamJson,
  parseClaudeStreamJson,
  parseCodexStreamJson,
  parseGeminiStreamJson,
} from './index.ts';

const lines = (...events: unknown[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

// Node must be on the stub binaries' PATH (`#!/usr/bin/env node`).
const STUB_ENV = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };

async function stubBinary(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  await writeFiles(dir, { [name]: body });
  const path = join(dir, name);
  await chmod(path, 0o755);
  return path;
}

test('buildAgyTaskArgs keeps -p=<prompt> last and omits --mode', () => {
  const taskArgs = buildAgyTaskArgs({
    prompt: 'Refactor config',
    timeoutSeconds: 600,
    sandbox: true,
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
});

test('buildAgyGraderArgs runs with --sandbox and without --dangerously-skip-permissions', () => {
  const agy = buildAgyGraderArgs({
    prompt: 'Grade',
    schemaPath: '/tmp/grader-schema.json',
    timeoutSeconds: 120,
    extraArgs: ['--verbose'],
  });
  assert.deepEqual(agy, [
    '--print-timeout=120s',
    '--output-format=json',
    '--json-schema=/tmp/grader-schema.json',
    '--sandbox',
    '--verbose',
    '-p=Grade',
  ]);
});

test('mentionsSkillFile requires a path boundary before skills/<name>/SKILL.md', () => {
  assert.equal(
    mentionsSkillFile('cat .agents/skills/demo-skill/SKILL.md', 'demo-skill'),
    true,
  );
  assert.equal(
    mentionsSkillFile('/w/.claude/skills/demo-skill/SKILL.md', 'demo-skill'),
    true,
  );
  assert.equal(
    mentionsSkillFile(
      'C:\\w\\.agents\\skills\\demo-skill\\SKILL.md',
      'demo-skill',
    ),
    true,
  );
  assert.equal(
    mentionsSkillFile(
      'cat .agents/skills/my-demo-skill/SKILL.md',
      'demo-skill',
    ),
    false,
  );
  assert.equal(
    mentionsSkillFile('cat fixtures/demo-skill/SKILL.md', 'demo-skill'),
    false,
  );
  assert.equal(
    mentionsSkillFile('cat .agents/skills/demo-skill/SKILL.mdx', 'demo-skill'),
    false,
  );
  assert.equal(
    mentionsSkillFile('cat .agents/myskills/demo-skill/SKILL.md', 'demo-skill'),
    false,
  );
});

test('parseAgyStreamJson detects view_file and run_command SKILL.md triggers and extracts result', () => {
  const viewFileStream = lines(
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'c-1',
        step_index: 1,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: {
            AbsolutePath: '/tmp/work/.agents/skills/demo-skill/SKILL.md',
          },
        },
      },
    },
    {
      event: 'result',
      result: {
        conversation_id: 'c-1',
        status: 'SUCCESS',
        response: 'Done with view_file',
        duration_seconds: 4.2,
        num_turns: 2,
        usage: {
          input_tokens: 300,
          output_tokens: 150,
          thinking_tokens: 10,
          cache_read_tokens: 0,
          total_tokens: 460,
        },
      },
    },
  );
  const commandStream = lines(
    {
      event: 'step_update',
      step_update: {
        tool_name: 'run_command',
        tool_info: {
          parameters: { CommandLine: 'cat .agents/skills/demo-skill/SKILL.md' },
        },
      },
    },
    { event: 'result', result: { status: 'SUCCESS', response: 'Done' } },
  );
  const nonTriggerStream = lines(
    {
      event: 'step_update',
      step_update: {
        tool_name: 'view_file',
        tool_info: { parameters: { AbsolutePath: '/tmp/work/README.md' } },
      },
    },
    { event: 'result', result: { status: 'SUCCESS', response: 'No skill' } },
  );

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
    total_tokens: 460,
  });
  assert.equal(parsedView.usageReported, true);
  assert.equal(parsedCommand.triggered, true);
  assert.equal(parsedCommand.usageReported, false);
  assert.equal(parsedNonTrigger.triggered, false);
});

test('parseAgyStreamJson marks ERROR/CANCELED results as failed even with a response', () => {
  const parsed = parseAgyStreamJson({
    stdout: lines({
      event: 'result',
      result: { status: 'CANCELED', response: 'partial' },
    }),
    skillName: 'demo-skill',
  });
  assert.equal(parsed.error, 'status CANCELED');
  assert.equal(parsed.response, 'partial');
});

test('parseAgyGraderJson prefers structured_output and falls back to response JSON', () => {
  const first = parseAgyGraderJson({
    stdout: JSON.stringify({
      status: 'SUCCESS',
      structured_output: {
        results: [{ assertion: 'A', passed: true, evidence: 'Found A' }],
      },
      response: 'ignored text',
      duration_seconds: 0.8,
      usage: { input_tokens: 40, output_tokens: 20, total_tokens: 60 },
    }),
  });
  const second = parseAgyGraderJson({
    stdout: JSON.stringify({
      status: 'SUCCESS',
      response: JSON.stringify({
        results: [{ assertion: 'B', passed: false, evidence: 'Missing B' }],
      }),
      duration_seconds: 0.9,
    }),
  });

  assert.deepEqual(first.output, {
    results: [{ assertion: 'A', passed: true, evidence: 'Found A' }],
  });
  assert.equal(first.durationMs, 800);
  assert.deepEqual(second.output, {
    results: [{ assertion: 'B', passed: false, evidence: 'Missing B' }],
  });
  assert.throws(
    () =>
      parseAgyGraderJson({
        stdout: JSON.stringify({ status: 'ERROR', error: 'quota' }),
      }),
    /agy grader failed: quota/,
  );
});

test('stream parsers report a missing final result instead of throwing', () => {
  const truncated = lines({ type: 'step_update', tool_name: 'view_file' });
  for (const parse of [
    parseAgyStreamJson,
    parseClaudeStreamJson,
    parseCodexStreamJson,
    parseGeminiStreamJson,
  ]) {
    const parsed = parse({ stdout: truncated, skillName: 'demo-skill' });
    assert.equal(parsed.sawResult, false);
    assert.equal(parsed.usageReported, false);
    assert.equal(parsed.usage.total_tokens, 0);
  }
});

test('normalizeUsage adds Anthropic cache counters and ignores invalid values', () => {
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 4,
    }),
    { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
  );
  assert.deepEqual(normalizeUsage({ input_tokens: -1, output_tokens: 'x' }), {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  });
});

test('agy does not retry task runs but retries grader runs with distinct log files and cleaned workdir', async (t) => {
  const root = await tempDir(t);
  const counter = join(root, 'count');
  const graderWorkdir = join(root, 'grader-work');
  const runDir = join(root, 'run');
  // Fails (no result) on the first two invocations, then succeeds.
  const binary = await stubBinary(
    root,
    'agy',
    [
      '#!/usr/bin/env node',
      "const { readFileSync, writeFileSync } = require('node:fs');",
      `const file = ${JSON.stringify(counter)};`,
      "let n = 0; try { n = Number(readFileSync(file, 'utf8')); } catch {}",
      'n += 1; writeFileSync(file, String(n));',
      "writeFileSync('leftover-' + n + '.txt', 'dirty');",
      'if (n < 3) { console.error(`attempt ${n} failed`); process.exit(2); }',
      "console.log(JSON.stringify({ status: 'SUCCESS', structured_output: { results: [] }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));",
      '',
    ].join('\n'),
  );
  const runner = createAgyRunner({
    binary,
    env: STUB_ENV,
    graderRetryDelayMs: 0,
  });

  const task = await runner.runTask({
    prompt: 'Hello',
    workdir: root,
    runDir,
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  assert.equal(await readFile(counter, 'utf8'), '1');
  assert.match(
    task.error ?? '',
    /agy exited with code 2; stderr: attempt 1 failed/,
  );

  await writeFiles(graderWorkdir, { 'stale.txt': 'x' });
  const grader = await runner.runGrader({
    prompt: 'Grade',
    schemaPath: join(root, 'schema.json'),
    schema: {},
    workdir: graderWorkdir,
    runDir,
    timeoutSeconds: 10,
  });
  assert.equal(await readFile(counter, 'utf8'), '3');
  assert.deepEqual(grader.output, { results: [] });
  assert.match(
    await readFile(join(runDir, 'grader-stderr.log'), 'utf8'),
    /attempt 2 failed/,
  );
  assert.match(
    await readFile(join(runDir, 'grader-retry-1-stdout.log'), 'utf8'),
    /structured_output/,
  );
  assert.deepEqual(await readdir(graderWorkdir), ['leftover-3.txt']);
});

test('detectDefaultRunner prioritizes agy -> claude -> codex -> gemini and agy runner executes binary', async (t) => {
  const root = await tempDir(t);
  const binDir = join(root, 'bin');
  const runDir = join(root, 'run');
  await stubBinary(binDir, 'claude', '#!/bin/sh\nexit 0\n');
  const stubAgy = await stubBinary(
    binDir,
    'agy',
    [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ event: "step_update", step_update: { tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "/work/.agents/skills/demo-skill/SKILL.md" } } } }));',
      'console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "stub response", duration_seconds: 0.321, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }));',
      '',
    ].join('\n'),
  );

  const detected = await detectDefaultRunner({ searchPath: [binDir] });
  const runner = createEvalRunner({
    runner: 'agy',
    binary: stubAgy,
    env: STUB_ENV,
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
  assert.equal(taskResult.error, undefined);
  assert.equal(taskResult.triggered, true);
  assert.equal(taskResult.response, 'stub response');
  assert.equal(taskResult.durationMs, 321);
  assert.equal(taskResult.usageReported, true);
  assert.match(loggedStdout, /stub response/);
});

test('every runner implements preflight and reports whether it honors --sandbox', async (t) => {
  const root = await tempDir(t);
  const binDir = join(root, 'bin');
  const env = { PATH: binDir };
  for (const name of ['agy', 'claude', 'codex', 'gemini'] as const) {
    const missing = createEvalRunner({ runner: name, env });
    await assert.rejects(
      missing.preflight?.() ?? Promise.resolve(),
      RunnerError,
    );
    await stubBinary(binDir, name, '#!/bin/sh\nexit 0\n');
    await createEvalRunner({ runner: name, env }).preflight?.();
  }

  const sandbox = Object.fromEntries(
    (['agy', 'claude', 'codex', 'gemini', 'fake'] as const).map((name) => [
      name,
      createEvalRunner({ runner: name, env }).sandboxSupported,
    ]),
  );
  assert.deepEqual(sandbox, {
    agy: true,
    claude: false,
    codex: true,
    gemini: true,
    fake: true,
  });
});
