import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { RunnerError } from '../../errors.ts';
import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import {
  buildGeminiGraderArgs,
  createEvalRunner,
  parseClaudeStreamJson,
  parseCodexStreamJson,
  parseGeminiGraderJson,
  parseGeminiStreamJson,
} from './index.ts';

const lines = (...events: unknown[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

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

test('buildGeminiGraderArgs uses default approval mode', () => {
  const gemini = buildGeminiGraderArgs('Grade');
  assert.ok(gemini.includes('--approval-mode=default'));
  assert.equal(gemini.includes('--approval-mode=yolo'), false);
});

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

test('usageReported is false when every token counter is zero, e.g. on failed runs', () => {
  const geminiFailed = parseGeminiStreamJson({
    stdout: lines({
      type: 'result',
      status: 'error',
      error: { type: 'ApiError', message: 'quota exceeded' },
      stats: {
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 12,
        tool_calls: 0,
      },
    }),
    skillName: 'demo-skill',
  });
  assert.equal(geminiFailed.error, 'quota exceeded');
  assert.equal(geminiFailed.usageReported, false);

  const claudeZero = parseClaudeStreamJson({
    stdout: lines({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      errors: ['startup failed'],
    }),
    skillName: 'demo-skill',
  });
  assert.equal(claudeZero.usageReported, false);

  const codexCachedOnly = parseCodexStreamJson({
    stdout: lines({
      type: 'turn.completed',
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 3 },
    }),
    skillName: 'demo-skill',
  });
  assert.equal(codexCachedOnly.usageReported, true);
});
