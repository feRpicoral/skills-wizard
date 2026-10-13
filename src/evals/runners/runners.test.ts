import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { RunnerError } from '../../errors.ts';
import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import { createAgyRunner } from './agy.ts';
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
  createFakeRunner,
  detectDefaultRunner,
  mentionsSkillFile,
  normalizeUsage,
  parseAgyGraderJson,
  parseAgyStreamJson,
  parseClaudeGraderJson,
  parseClaudeStreamJson,
  parseCodexGraderJson,
  parseCodexStreamJson,
  parseGeminiGraderJson,
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

// --- Argument builders -------------------------------------------------------

test('task builders keep the prompt as one positional value, even when it starts with "-" or names a subcommand', () => {
  for (const prompt of ['-v explain this', '--help', 'resume', 'plain text']) {
    const claude = buildClaudeTaskArgs({
      prompt,
      skillName: 'demo-skill',
      excludeSkill: true,
    });
    // `--disallowedTools` is variadic: without `--` it swallows the prompt.
    assert.deepEqual(claude.slice(-4), [
      '--disallowedTools',
      'Skill(demo-skill)',
      '--',
      prompt,
    ]);
    assert.deepEqual(
      buildClaudeTaskArgs({ prompt, skillName: 'demo-skill' }).slice(-2),
      ['--', prompt],
    );

    assert.deepEqual(buildCodexTaskArgs(prompt).slice(-2), ['--', prompt]);
    assert.deepEqual(
      buildCodexGraderArgs({ prompt, schemaPath: '/s.json' }).slice(-2),
      ['--', prompt],
    );
    assert.equal(buildGeminiTaskArgs({ prompt }).at(-1), `--prompt=${prompt}`);
    assert.equal(buildGeminiGraderArgs(prompt).at(-1), `--prompt=${prompt}`);
    assert.equal(
      buildAgyTaskArgs({ prompt, timeoutSeconds: 60 }).at(-1),
      `-p=${prompt}`,
    );
    assert.deepEqual(buildClaudeGraderArgs({ prompt, schema: {} }).slice(-2), [
      '--',
      prompt,
    ]);
  }
});

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

test('grader builders use the most restrictive tool and permission mode of each CLI', () => {
  const claude = buildClaudeGraderArgs({
    prompt: 'Grade',
    schema: { type: 'object' },
  });
  assert.equal(claude.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(claude.slice(1, 7), [
    '--tools',
    '',
    '--disallowedTools=mcp__*',
    '--permission-mode',
    'dontAsk',
    '--output-format',
  ]);
  assert.equal(
    claude[claude.indexOf('--json-schema') + 1],
    '{"type":"object"}',
  );

  const codex = buildCodexGraderArgs({
    prompt: 'Grade',
    schemaPath: '/tmp/schema.json',
  });
  assert.deepEqual(codex.slice(0, 4), [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
  ]);
  assert.equal(codex[codex.indexOf('--output-schema') + 1], '/tmp/schema.json');

  const gemini = buildGeminiGraderArgs('Grade');
  assert.ok(gemini.includes('--approval-mode=default'));
  assert.equal(gemini.includes('--approval-mode=yolo'), false);

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

// --- Trigger detection -------------------------------------------------------

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

// --- Claude ------------------------------------------------------------------

const claudeInit = {
  type: 'system',
  subtype: 'init',
  cwd: '/w',
  session_id: 's-1',
  tools: ['Bash', 'Read', 'Skill'],
  model: 'claude-sonnet-4-5',
  permissionMode: 'bypassPermissions',
};

test('parseClaudeStreamJson reads the documented result message, including cache tokens', () => {
  const stdout = lines(
    claudeInit,
    {
      type: 'assistant',
      session_id: 's-1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Skill',
            input: { skill: 'demo-skill' },
          },
        ],
      },
    },
    {
      type: 'user',
      session_id: 's-1',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
        ],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1500,
      duration_api_ms: 1300,
      num_turns: 2,
      result: 'Claude output',
      session_id: 's-1',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 900,
        output_tokens: 80,
        server_tool_use: { web_search_requests: 0 },
        service_tier: 'standard',
      },
      permission_denials: [],
    },
  );

  const parsed = parseClaudeStreamJson({ stdout, skillName: 'demo-skill' });

  assert.equal(parsed.triggered, true);
  assert.equal(parsed.response, 'Claude output');
  assert.equal(parsed.durationMs, 1500);
  assert.deepEqual(parsed.usage, {
    input_tokens: 1020,
    output_tokens: 80,
    total_tokens: 1100,
  });
  assert.equal(parsed.usageReported, true);
  assert.equal(parsed.sawResult, true);
  assert.equal(parsed.error, undefined);
});

test('parseClaudeStreamJson marks error results (is_error / error_* subtypes) as failed', () => {
  const stdout = lines(claudeInit, {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    duration_ms: 900,
    num_turns: 10,
    session_id: 's-1',
    total_cost_usd: 0.2,
    usage: { input_tokens: 5, output_tokens: 1 },
    errors: ['Reached maximum number of turns (10)'],
  });

  const parsed = parseClaudeStreamJson({ stdout, skillName: 'demo-skill' });

  assert.equal(parsed.response, '');
  assert.equal(
    parsed.error,
    'error_max_turns: Reached maximum number of turns (10)',
  );
});

test('Claude trigger detection reads Read/Bash paths with a path boundary', () => {
  const readStream = (filePath: string): string =>
    lines(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: filePath } },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: '' },
    );

  assert.equal(
    parseClaudeStreamJson({
      stdout: readStream('/w/.claude/skills/demo-skill/SKILL.md'),
      skillName: 'demo-skill',
    }).triggered,
    true,
  );
  assert.equal(
    parseClaudeStreamJson({
      stdout: readStream('/w/.claude/skills/not-demo-skill/SKILL.md'),
      skillName: 'demo-skill',
    }).triggered,
    false,
  );
});

test('parseClaudeGraderJson prefers structured_output and throws on error results', () => {
  const output = { results: [{ assertion: 'A', passed: true, evidence: 'e' }] };
  const parsed = parseClaudeGraderJson({
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 700,
      result: JSON.stringify(output),
      structured_output: output,
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    }),
  });
  assert.deepEqual(parsed.output, output);
  assert.equal(parsed.usage.input_tokens, 15);

  assert.throws(
    () =>
      parseClaudeGraderJson({
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'error_max_structured_output_retries',
          is_error: true,
          errors: ['schema validation failed'],
        }),
      }),
    /error_max_structured_output_retries: schema validation failed/,
  );
});

// --- Gemini ------------------------------------------------------------------

test('parseGeminiStreamJson assembles assistant deltas and reads usage from result.stats', () => {
  const stdout = lines(
    {
      type: 'init',
      timestamp: '2026-01-01T00:00:00.000Z',
      session_id: 's-1',
      model: 'gemini-2.5-pro',
    },
    {
      type: 'message',
      timestamp: '2026-01-01T00:00:00.100Z',
      role: 'user',
      content: 'Run gemini',
    },
    {
      type: 'tool_use',
      timestamp: '2026-01-01T00:00:01.000Z',
      tool_name: 'activate_skill',
      tool_id: 'activate_skill-1',
      parameters: { name: 'demo-skill' },
    },
    {
      type: 'tool_result',
      timestamp: '2026-01-01T00:00:01.500Z',
      tool_id: 'activate_skill-1',
      status: 'success',
      output: 'Skill activated',
    },
    {
      type: 'message',
      timestamp: '2026-01-01T00:00:02.000Z',
      role: 'assistant',
      content: 'Gemini ',
      delta: true,
    },
    {
      type: 'message',
      timestamp: '2026-01-01T00:00:02.100Z',
      role: 'assistant',
      content: 'output',
      delta: true,
    },
    {
      type: 'result',
      timestamp: '2026-01-01T00:00:03.000Z',
      status: 'success',
      stats: {
        total_tokens: 300,
        input_tokens: 180,
        output_tokens: 90,
        cached: 40,
        input: 140,
        duration_ms: 1300,
        tool_calls: 1,
      },
    },
  );

  const parsed = parseGeminiStreamJson({ stdout, skillName: 'demo-skill' });

  assert.equal(parsed.triggered, true);
  assert.equal(parsed.response, 'Gemini output');
  assert.equal(parsed.durationMs, 1300);
  assert.deepEqual(parsed.usage, {
    input_tokens: 180,
    output_tokens: 90,
    total_tokens: 300,
  });
  assert.equal(parsed.usageReported, true);
  assert.equal(parsed.error, undefined);
});

test('parseGeminiStreamJson marks status:error results as failed', () => {
  const parsed = parseGeminiStreamJson({
    stdout: lines(
      { type: 'init', session_id: 's', model: 'm' },
      {
        type: 'result',
        status: 'error',
        error: { type: 'FatalTurnLimitedError', message: 'turn limit' },
        stats: { total_tokens: 10, input_tokens: 8, output_tokens: 2 },
      },
    ),
    skillName: 'demo-skill',
  });
  assert.equal(parsed.error, 'turn limit');
  assert.equal(parsed.sawResult, true);
});

test('parseGeminiGraderJson sums stats.models[*].tokens and throws on error', () => {
  const output = { results: [{ assertion: 'A', passed: true, evidence: 'e' }] };
  const parsed = parseGeminiGraderJson({
    stdout: JSON.stringify({
      session_id: 's-1',
      response: `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
      stats: {
        models: {
          'gemini-2.5-pro': {
            api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 900 },
            tokens: {
              input: 90,
              prompt: 100,
              candidates: 20,
              total: 130,
              cached: 10,
              thoughts: 10,
              tool: 0,
            },
          },
          'gemini-2.5-flash': {
            api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
            tokens: {
              input: 10,
              prompt: 10,
              candidates: 5,
              total: 15,
              cached: 0,
              thoughts: 0,
              tool: 0,
            },
          },
        },
        tools: { totalCalls: 0 },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      },
    }),
  });

  assert.deepEqual(parsed.output, output);
  assert.deepEqual(parsed.usage, {
    input_tokens: 110,
    output_tokens: 25,
    total_tokens: 145,
  });
  assert.throws(
    () =>
      parseGeminiGraderJson({
        stdout: JSON.stringify({
          error: { type: 'Error', message: 'quota exceeded', code: 1 },
        }),
      }),
    /quota exceeded/,
  );
});

// --- Codex -------------------------------------------------------------------

test('parseCodexStreamJson reads exec --json events and turn.completed usage', () => {
  const stdout = lines(
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: {
        id: 'item_0',
        type: 'command_execution',
        command: "bash -lc 'cat .agents/skills/demo-skill/SKILL.md'",
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'item_1', type: 'agent_message', text: 'Codex output' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 150, cached_input_tokens: 100, output_tokens: 75 },
    },
  );

  const parsed = parseCodexStreamJson({
    stdout,
    skillName: 'demo-skill',
    fallbackDurationMs: 1100,
  });

  assert.equal(parsed.triggered, true);
  assert.equal(parsed.response, 'Codex output');
  assert.equal(parsed.durationMs, 1100);
  // Cached input tokens are a subset of input_tokens.
  assert.deepEqual(parsed.usage, {
    input_tokens: 150,
    output_tokens: 75,
    total_tokens: 225,
  });
  assert.equal(parsed.usageReported, true);
  assert.equal(parsed.error, undefined);
});

test('parseCodexStreamJson fails on turn.failed and on error events without a completed turn', () => {
  const failed = parseCodexStreamJson({
    stdout: lines(
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'model overloaded' } },
    ),
    skillName: 'demo-skill',
  });
  assert.equal(failed.error, 'model overloaded');

  const errored = parseCodexStreamJson({
    stdout: lines({ type: 'error', message: 'stream disconnected' }),
    skillName: 'demo-skill',
  });
  assert.equal(errored.error, 'stream disconnected');
  assert.equal(errored.sawResult, false);

  const recovered = parseCodexStreamJson({
    stdout: lines(
      { type: 'error', message: 'reconnecting' },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ),
    skillName: 'demo-skill',
  });
  assert.equal(recovered.error, undefined);

  assert.throws(
    () =>
      parseCodexGraderJson({
        stdout: lines({ type: 'turn.failed', error: { message: 'boom' } }),
      }),
    /codex grader failed: boom/,
  );
});

// --- agy ---------------------------------------------------------------------

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

// --- Shared parsing behavior -------------------------------------------------

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

// --- Runners with stub binaries ----------------------------------------------

test('runTask returns a failed result (with the stderr tail) instead of throwing on non-zero exit', async (t) => {
  const root = await tempDir(t);
  const binary = await stubBinary(
    root,
    'claude',
    '#!/bin/sh\necho "auth failed: run claude login" >&2\nexit 1\n',
  );
  const runner = createEvalRunner({ runner: 'claude', binary, env: STUB_ENV });

  const result = await runner.runTask({
    prompt: 'Hello',
    workdir: root,
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.match(result.error ?? '', /claude exited with code 1/);
  assert.match(result.error ?? '', /auth failed: run claude login/);
  assert.match(result.rawStderr, /auth failed/);
  assert.equal(result.usageReported, false);
});

test('runTask returns a failed result for error results and timeouts', async (t) => {
  const root = await tempDir(t);
  const errorResult = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['tool crashed'],
    usage: { input_tokens: 3, output_tokens: 1 },
  });
  const erroring = await stubBinary(
    root,
    'claude-error',
    `#!/bin/sh\necho '${errorResult}'\nexit 1\n`,
  );
  const slow = await stubBinary(
    root,
    'gemini-slow',
    '#!/bin/sh\nexec sleep 30\n',
  );

  const errored = await createEvalRunner({
    runner: 'claude',
    binary: erroring,
    env: STUB_ENV,
  }).runTask({
    prompt: 'Hello',
    workdir: root,
    runDir: join(root, 'run-error'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  assert.match(
    errored.error ?? '',
    /claude reported an error: error_during_execution: tool crashed/,
  );
  assert.equal(errored.usageReported, true);

  const started = Date.now();
  const timedOut = await createEvalRunner({
    runner: 'gemini',
    binary: slow,
    env: STUB_ENV,
  }).runTask({
    prompt: 'Hello',
    workdir: root,
    runDir: join(root, 'run-slow'),
    skillName: 'demo-skill',
    timeoutSeconds: 0.2,
  });
  assert.equal(timedOut.timedOut, true);
  assert.match(timedOut.error ?? '', /gemini timed out after 0.2s/);
  assert.ok(Date.now() - started < 5_000);
});

test('the claude runner passes a dash-leading prompt through unchanged after --', async (t) => {
  const root = await tempDir(t);
  const argvFile = join(root, 'argv.json');
  const binary = await stubBinary(
    root,
    'claude',
    [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }));",
      '',
    ].join('\n'),
  );

  const result = await createEvalRunner({
    runner: 'claude',
    binary,
    env: STUB_ENV,
  }).runTask({
    prompt: '--version please',
    workdir: root,
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
    excludeSkill: true,
  });
  const argv = JSON.parse(await readFile(argvFile, 'utf8')) as string[];

  assert.equal(result.error, undefined);
  assert.deepEqual(argv.slice(-2), ['--', '--version please']);
});

test('the gemini runner trusts the eval workspace through GEMINI_CLI_TRUST_WORKSPACE for task and grader runs', async (t) => {
  const root = await tempDir(t);
  const logFile = join(root, 'calls.jsonl');
  const binary = await stubBinary(
    root,
    'gemini',
    [
      '#!/usr/bin/env node',
      "const { appendFileSync } = require('node:fs');",
      'const args = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null }) + '\\n');`,
      "if (args.includes('--output-format=json')) {",
      '  console.log(JSON.stringify({ response: JSON.stringify({ results: [] }), stats: { models: {} } }));',
      '} else {',
      "  console.log(JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1, total_tokens: 2, duration_ms: 5 } }));",
      '}',
      '',
    ].join('\n'),
  );
  const runner = createEvalRunner({ runner: 'gemini', binary, env: STUB_ENV });

  const task = await runner.runTask({
    prompt: 'do it',
    workdir: root,
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  await runner.runGrader({
    prompt: 'grade it',
    schemaPath: join(root, 'schema.json'),
    schema: {},
    workdir: root,
    runDir: join(root, 'run'),
    timeoutSeconds: 10,
  });
  const calls = (await readFile(logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; trust: string });

  assert.equal(task.error, undefined);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.trust, 'true');
    // Older Gemini CLI versions reject unknown flags such as --skip-trust.
    assert.equal(call.args.includes('--skip-trust'), false);
  }
  assert.equal('GEMINI_CLI_TRUST_WORKSPACE' in STUB_ENV, false);
});

test('agy does not retry task runs but retries grader runs', async (t) => {
  const root = await tempDir(t);
  const counter = join(root, 'count');
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
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  assert.equal(await readFile(counter, 'utf8'), '1');
  assert.match(
    task.error ?? '',
    /agy exited with code 2; stderr: attempt 1 failed/,
  );

  const grader = await runner.runGrader({
    prompt: 'Grade',
    schemaPath: join(root, 'schema.json'),
    schema: {},
    workdir: root,
    runDir: join(root, 'run'),
    timeoutSeconds: 10,
  });
  assert.equal(await readFile(counter, 'utf8'), '3');
  assert.deepEqual(grader.output, { results: [] });
});

test('runGrader throws RunnerError with the stderr tail when the grader fails', async (t) => {
  const root = await tempDir(t);
  const binary = await stubBinary(
    root,
    'gemini',
    '#!/bin/sh\necho "not json"\necho "rate limited" >&2\nexit 1\n',
  );
  const runner = createEvalRunner({ runner: 'gemini', binary, env: STUB_ENV });

  await assert.rejects(
    runner.runGrader({
      prompt: 'Grade',
      schemaPath: join(root, 'schema.json'),
      schema: {},
      workdir: root,
      runDir: join(root, 'run'),
      timeoutSeconds: 10,
    }),
    (error: unknown) =>
      error instanceof RunnerError &&
      /gemini grader exited with code 1/.test(error.message) &&
      /rate limited/.test(error.message),
  );
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

  await createFakeRunner().preflight?.();
  await assert.rejects(
    createFakeRunner({
      onPreflight: () => {
        throw new RunnerError('fake runner unavailable');
      },
    }).preflight?.() ?? Promise.resolve(),
    /fake runner unavailable/,
  );
  assert.equal(
    createFakeRunner({ sandboxSupported: false }).sandboxSupported,
    false,
  );
});

test('the fake runner passes error and usageReported through', async (t) => {
  const root = await tempDir(t);
  const runner = createFakeRunner({
    onTask: () => ({ error: 'simulated failure', usageReported: false }),
  });
  const result = await runner.runTask({
    prompt: 'Hello',
    workdir: root,
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  assert.equal(result.error, 'simulated failure');
  assert.equal(result.usageReported, false);
});

test('the fake runner sees the skill only when it is staged in .agents/skills and not excluded', async (t) => {
  const root = await tempDir(t);
  const runner = createFakeRunner();
  const run = (workdir: string, excludeSkill?: boolean) =>
    runner.runTask({
      prompt: 'Hello',
      workdir,
      runDir: join(root, 'run'),
      skillName: 'demo-skill',
      timeoutSeconds: 10,
      excludeSkill,
    });
  const staged = join(root, 'staged');
  await writeFiles(staged, {
    '.agents/skills/demo-skill/SKILL.md': '---\nname: demo-skill\n---\n',
    // Nothing writes this file anymore, so it must not hide the skill.
    '.agents/skills.json': JSON.stringify({ exclude: ['demo-skill'] }),
  });
  const baseline = join(root, 'baseline');
  await writeFiles(baseline, { 'input.txt': 'hello\n' });

  assert.equal((await run(staged)).triggered, true);
  assert.equal((await run(staged, true)).triggered, false);
  assert.equal((await run(baseline)).triggered, false);
  assert.match((await run(baseline)).response, /without skill/);
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
