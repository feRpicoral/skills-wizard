import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateBenchmark, type VariantAggregate } from './aggregate.ts';
import {
  codeBlock,
  codeSpan,
  escapeTableCell,
  formatPassRateDelta,
  renderBenchmarkReport,
} from './report.ts';

function variant(passRate: number): VariantAggregate {
  const stat = { mean: passRate, stddev: 0, min: passRate, max: passRate };
  return {
    runs: 1,
    failed_runs: 0,
    usage_reported_runs: 1,
    pass_rate: stat,
    time_seconds: stat,
    tokens: stat,
  };
}

test('formatPassRateDelta renders pass-rate deltas in percentage points', () => {
  assert.equal(formatPassRateDelta(variant(1), variant(2 / 3)), '+33.3 pp');
  assert.equal(formatPassRateDelta(variant(0.5), variant(1)), '-50.0 pp');
  assert.equal(formatPassRateDelta(variant(0.5), variant(0.5)), '+0.0 pp');
  assert.equal(
    formatPassRateDelta(variant(0.5), variant(0.5000001)),
    '+0.0 pp',
  );
});

test('escapeTableCell collapses newlines and escapes pipes', () => {
  assert.equal(escapeTableCell('a | b\nc\r\n  d'), 'a \\| b c d');
});

test('codeSpan uses a fence longer than any backtick run in the text', () => {
  assert.equal(codeSpan('plain'), '`plain`');
  assert.equal(codeSpan('run `x` now'), '``run `x` now``');
  assert.equal(codeSpan('``a``'), '``` ``a`` ```');
  assert.equal(codeSpan('two\nlines'), '`two lines`');
});

test('codeBlock uses a fence the text cannot close', () => {
  assert.deepEqual(codeBlock('use ```js\ncode\n```'), [
    '````text',
    'use ```js\ncode\n```',
    '````',
  ]);
  assert.deepEqual(codeBlock('plain'), ['```text', 'plain', '```']);
});

test('renderBenchmarkReport keeps tables and lists intact for hostile text', () => {
  const assertion = 'Output has a | pipe\nand a `tick`';
  const benchmark = aggregateBenchmark({
    skillName: 'demo-skill',
    skillPath: '/repo/skills/demo-skill',
    runner: 'fake',
    runsPerConfig: 1,
    baselineEnabled: true,
    timestamp: '2026-04-12T00:00:00.000Z',
    cases: [
      {
        id: 'case-1',
        prompt: '# Not a heading\n```\nfenced\n```',
        expected_output: 'Done',
        files: [],
        assertions: [assertion],
      },
    ],
    runs: (['with_skill', 'without_skill'] as const).map((name) => ({
      case_id: 'case-1',
      prompt: 'p',
      variant: name,
      run_index: 1,
      grading: {
        expectations: [
          {
            text: assertion,
            kind: 'string' as const,
            passed: name === 'with_skill',
            evidence: 'line one\n\n## injected heading\n- injected item',
          },
        ],
        summary: {
          passed: name === 'with_skill' ? 1 : 0,
          failed: name === 'with_skill' ? 0 : 1,
          total: 1,
          pass_rate: name === 'with_skill' ? 1 : 0,
        },
      },
      timing: {
        duration_ms: 1000,
        total_duration_seconds: 1,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
        triggered: false,
        exit_code: 0,
        timed_out: false,
        usage_reported: true,
      },
    })),
  });
  const markdown = renderBenchmarkReport(benchmark);
  const lines = markdown.split('\n');

  assert.ok(
    lines.includes(
      '| Output has a \\| pipe and a `tick` | `string` | 100.0% | 0.0% | `differentiating` |',
    ),
  );
  assert.ok(
    lines.includes(
      '- **Pass only with skill (1):** `` case-1: Output has a | pipe and a `tick` ``',
    ),
  );
  assert.ok(
    lines.includes(
      '- **[PASS]** Output has a | pipe and a `tick`: line one ## injected heading - injected item',
    ),
  );
  assert.equal(lines.includes('## injected heading'), false);
  assert.ok(lines.includes('````text'));
  assert.ok(lines.includes('# Not a heading'));
  assert.match(
    markdown,
    /sample standard deviations \(sd\) are taken across case runs/,
  );
  assert.match(
    markdown,
    /\| \*\*Delta \(vs baseline\)\*\* \| \*\*\+100\.0 pp\*\* \| \*\*\+0\.00s\*\* \| \*\*\+0\*\* \| \|/,
  );
});
