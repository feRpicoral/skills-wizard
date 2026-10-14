import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCodexGraderArgs,
  parseCodexGraderJson,
  parseCodexStreamJson,
} from './index.ts';

const lines = (...events: unknown[]): string =>
  `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

test('buildCodexGraderArgs uses read-only sandbox and --skip-git-repo-check', () => {
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
});

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
