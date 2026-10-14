import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import {
  buildAgyTaskArgs,
  buildClaudeGraderArgs,
  buildClaudeTaskArgs,
  buildCodexGraderArgs,
  buildCodexTaskArgs,
  buildGeminiGraderArgs,
  buildGeminiTaskArgs,
  createEvalRunner,
  parseClaudeGraderJson,
  parseClaudeStreamJson,
  resolveRunnerBinary,
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

const claudeInit = {
  type: 'system',
  subtype: 'init',
  cwd: '/w',
  session_id: 's-1',
  tools: ['Bash', 'Read', 'Skill'],
  model: 'claude-sonnet-4-5',
  permissionMode: 'bypassPermissions',
};

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

test('buildClaudeGraderArgs uses restrictive tool and permission mode', () => {
  const claude = buildClaudeGraderArgs({
    prompt: 'Grade',
    schema: { type: 'object' },
  });
  assert.equal(claude.includes('--dangerously-skip-permissions'), false);
  // `--disallowedTools "*"` would also remove the structured-output tool.
  assert.equal(
    claude.some((arg) => arg === '*' || arg.endsWith('=*')),
    false,
  );
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
});

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

test('parseClaudeGraderJson requires structured_output and throws on error results', () => {
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
  // A success result without structured_output is a failure, even when the
  // text result happens to be JSON.
  assert.throws(
    () =>
      parseClaudeGraderJson({
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify(output),
        }),
      }),
    /no structured_output/,
  );
});

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

test('createEvalRunner resolves a relative --binary path against the given cwd', async (t) => {
  const root = await tempDir(t);
  const cliCwd = join(root, 'project');
  const workdir = join(root, 'workdir');
  await writeFiles(workdir, { 'README.md': 'x' });
  await stubBinary(
    join(cliCwd, 'bin'),
    'claude',
    `#!/bin/sh\necho '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'relative ok', usage: { input_tokens: 1, output_tokens: 1 } })}'\n`,
  );

  assert.equal(
    resolveRunnerBinary({ binary: './bin/claude', cwd: cliCwd }),
    join(cliCwd, 'bin', 'claude'),
  );
  assert.equal(
    resolveRunnerBinary({ binary: 'claude', cwd: cliCwd }),
    'claude',
  );
  assert.equal(
    resolveRunnerBinary({ binary: '/opt/claude', cwd: cliCwd }),
    '/opt/claude',
  );

  const runner = createEvalRunner({
    runner: 'claude',
    binary: './bin/claude',
    cwd: cliCwd,
    env: STUB_ENV,
  });
  await runner.preflight?.();
  const result = await runner.runTask({
    prompt: 'Hello',
    workdir,
    runDir: join(root, 'run'),
    skillName: 'demo-skill',
    timeoutSeconds: 10,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.response, 'relative ok');
});
