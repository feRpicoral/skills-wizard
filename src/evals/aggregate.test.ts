import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateBenchmark,
  aggregateTriggerRuns,
  computeStatSummary,
} from './aggregate.ts';
import { renderBenchmarkReport, renderTriggerReport } from './report.ts';

test('computeStatSummary calculates mean, sample stddev, min, and max', () => {
  const singleValues = [0.8];
  const multipleValues = [0.5, 1.0];

  const single = computeStatSummary(singleValues);
  const multiple = computeStatSummary(multipleValues);

  assert.deepEqual(single, { mean: 0.8, stddev: 0, min: 0.8, max: 0.8 });
  assert.equal(multiple.mean, 0.75);
  assert.equal(multiple.min, 0.5);
  assert.equal(multiple.max, 1);
  assert.ok(multiple.stddev > 0.35 && multiple.stddev < 0.36);
});

test('aggregateBenchmark and renderBenchmarkReport classify non-discriminating, differentiating, failing, and flaky assertions', () => {
  const timing = {
    duration_ms: 1200,
    total_duration_seconds: 1.2,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    triggered: true,
    exit_code: 0,
    timed_out: false,
  };
  const baselineTiming = {
    duration_ms: 1000,
    total_duration_seconds: 1.0,
    input_tokens: 80,
    output_tokens: 40,
    total_tokens: 120,
    triggered: false,
    exit_code: 0,
    timed_out: false,
  };

  const benchmark = aggregateBenchmark({
    skillName: 'demo-skill',
    skillPath: '/repo/skills/demo-skill',
    runner: 'codex',
    runsPerConfig: 2,
    baselineEnabled: true,
    possiblyContaminated: true,
    warnings: ['Baseline possibly contaminated due to global skill install.'],
    timestamp: '2026-04-12T00:00:00.000Z',
    cases: [
      {
        id: 'case-1',
        prompt: 'Create config',
        expected_output: 'Valid config',
        files: [],
        assertions: [
          'Always passes in both',
          'Only passes with skill',
          'Flaky assertion',
        ],
      },
    ],
    runs: [
      {
        case_id: 'case-1',
        prompt: 'Create config',
        variant: 'with_skill',
        run_index: 1,
        grading: {
          expectations: [
            {
              text: 'Always passes in both',
              kind: 'string',
              passed: true,
              evidence: 'Present in with_skill',
            },
            {
              text: 'Only passes with skill',
              kind: 'string',
              passed: true,
              evidence: 'Skill added strict option',
            },
            {
              text: 'Flaky assertion',
              kind: 'string',
              passed: true,
              evidence: 'Passed on run 1',
            },
          ],
          summary: { passed: 3, failed: 0, total: 3, pass_rate: 1 },
        },
        timing,
      },
      {
        case_id: 'case-1',
        prompt: 'Create config',
        variant: 'with_skill',
        run_index: 2,
        grading: {
          expectations: [
            {
              text: 'Always passes in both',
              kind: 'string',
              passed: true,
              evidence: 'Present in with_skill',
            },
            {
              text: 'Only passes with skill',
              kind: 'string',
              passed: true,
              evidence: 'Skill added strict option',
            },
            {
              text: 'Flaky assertion',
              kind: 'string',
              passed: false,
              evidence: 'Failed on run 2',
            },
          ],
          summary: { passed: 2, failed: 1, total: 3, pass_rate: 0.6667 },
        },
        timing,
      },
      {
        case_id: 'case-1',
        prompt: 'Create config',
        variant: 'without_skill',
        run_index: 1,
        grading: {
          expectations: [
            {
              text: 'Always passes in both',
              kind: 'string',
              passed: true,
              evidence: 'Present in baseline too',
            },
            {
              text: 'Only passes with skill',
              kind: 'string',
              passed: false,
              evidence: 'Missing strict option',
            },
            {
              text: 'Flaky assertion',
              kind: 'string',
              passed: false,
              evidence: 'Missing in baseline',
            },
          ],
          summary: { passed: 1, failed: 2, total: 3, pass_rate: 0.3333 },
        },
        timing: baselineTiming,
      },
      {
        case_id: 'case-1',
        prompt: 'Create config',
        variant: 'without_skill',
        run_index: 2,
        grading: {
          expectations: [
            {
              text: 'Always passes in both',
              kind: 'string',
              passed: true,
              evidence: 'Present in baseline too',
            },
            {
              text: 'Only passes with skill',
              kind: 'string',
              passed: false,
              evidence: 'Missing strict option',
            },
            {
              text: 'Flaky assertion',
              kind: 'string',
              passed: false,
              evidence: 'Missing in baseline',
            },
          ],
          summary: { passed: 1, failed: 2, total: 3, pass_rate: 0.3333 },
        },
        timing: baselineTiming,
      },
    ],
  });
  const markdown = renderBenchmarkReport(benchmark);

  assert.equal(benchmark.metadata.baseline_status, 'possibly contaminated');
  assert.deepEqual(benchmark.non_discriminating_assertions, [
    'case-1: Always passes in both',
  ]);
  assert.deepEqual(benchmark.assertion_analysis, {
    pass_only_with_skill: ['case-1: Only passes with skill'],
    pass_in_both: ['case-1: Always passes in both'],
    fail_in_both: [],
    flaky: ['case-1: Flaky assertion'],
  });
  assert.equal(benchmark.run_summary.delta?.pass_rate, '+0.50');
  assert.equal(benchmark.run_summary.delta?.tokens, '+30');
  assert.match(markdown, /possibly contaminated/);
  assert.match(markdown, /Non-Discriminating Assertions/);
  assert.match(markdown, /Assertion Analysis/);
  assert.match(markdown, /Flaky \(1\)/);
  assert.equal(markdown.includes('—'), false);
});

test('aggregateTriggerRuns and renderTriggerReport compute precision, recall, and false positive rate', () => {
  const queries = [
    { query: 'should trigger 1', should_trigger: true },
    { query: 'should trigger 2', should_trigger: true },
    { query: 'near miss 1', should_trigger: false },
    { query: 'near miss 2', should_trigger: false },
  ];
  const results = [
    {
      query: 'should trigger 1',
      should_trigger: true,
      triggered: true,
      duration_ms: 100,
    },
    {
      query: 'should trigger 1',
      should_trigger: true,
      triggered: true,
      duration_ms: 100,
    },
    {
      query: 'should trigger 2',
      should_trigger: true,
      triggered: false,
      duration_ms: 100,
    },
    {
      query: 'should trigger 2',
      should_trigger: true,
      triggered: false,
      duration_ms: 100,
    },
    {
      query: 'near miss 1',
      should_trigger: false,
      triggered: false,
      duration_ms: 100,
    },
    {
      query: 'near miss 1',
      should_trigger: false,
      triggered: false,
      duration_ms: 100,
    },
    {
      query: 'near miss 2',
      should_trigger: false,
      triggered: true,
      duration_ms: 100,
    },
    {
      query: 'near miss 2',
      should_trigger: false,
      triggered: false,
      duration_ms: 100,
    },
  ];

  const summary = aggregateTriggerRuns({
    skillName: 'demo-skill',
    skillPath: '/repo/skills/demo-skill',
    runner: 'agy',
    split: 'validation',
    runsPerQuery: 2,
    threshold: 0.5,
    timestamp: '2026-04-12T00:00:00.000Z',
    queries,
    results,
  });
  const markdown = renderTriggerReport(summary);

  assert.equal(summary.metrics.true_positives, 1);
  assert.equal(summary.metrics.false_negatives, 1);
  assert.equal(summary.metrics.true_negatives, 1);
  assert.equal(summary.metrics.false_positives, 1);
  assert.equal(summary.metrics.recall, 0.5);
  assert.equal(summary.metrics.precision, 0.5);
  assert.equal(summary.metrics.false_positive_rate, 0.5);
  assert.match(markdown, /Trigger Evaluation Report: `demo-skill`/);
  assert.match(markdown, /Recall \(Sensitivity\)/);
});
