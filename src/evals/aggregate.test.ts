import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir } from '../test-support/fixtures.ts';
import {
  aggregateBenchmark,
  aggregateTriggerRuns,
  computeStatSummary,
  type EvalRunRecord,
  loadBenchmarkFromIteration,
  loadTriggerSummary,
} from './aggregate.ts';
import type { TimingReport } from './grade.ts';
import { renderBenchmarkReport, renderTriggerReport } from './report.ts';
import type { EvalVariant } from './workspace.ts';

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
    regressing: [],
    regressing_vs_old: [],
  });
  assert.equal(benchmark.schema_version, 1);
  assert.equal(benchmark.run_summary.delta?.pass_rate, '+0.50');
  assert.equal(benchmark.run_summary.delta?.tokens, '+30');
  assert.match(markdown, /possibly contaminated/);
  assert.match(markdown, /Non-Discriminating Assertions/);
  assert.match(markdown, /Assertion Analysis/);
  assert.match(markdown, /Flaky \(vs baseline\) \(1\)/);
  assert.match(markdown, /- \*\*`with_skill` status:\*\* clean/);
  assert.equal(benchmark.metadata.with_skill_contaminated, false);
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

interface RunParams {
  variant: EvalVariant;
  passed: readonly boolean[];
  runIndex?: number;
  caseId?: string;
  timing?: Partial<TimingReport>;
}

function makeRun({
  variant,
  passed,
  runIndex = 1,
  caseId = 'case-1',
  timing = {},
}: RunParams): EvalRunRecord {
  const passedCount = passed.filter(Boolean).length;
  return {
    case_id: caseId,
    prompt: 'Do the task',
    variant,
    run_index: runIndex,
    grading: {
      expectations: passed.map((ok, index) => ({
        text: `Assertion ${index + 1}`,
        kind: 'string',
        passed: ok,
        evidence: ok ? 'Seen' : 'Missing',
      })),
      summary: {
        passed: passedCount,
        failed: passed.length - passedCount,
        total: passed.length,
        pass_rate: passed.length === 0 ? 0 : passedCount / passed.length,
      },
    },
    timing: {
      duration_ms: 1000,
      total_duration_seconds: 1,
      input_tokens: 60,
      output_tokens: 40,
      total_tokens: 100,
      triggered: false,
      exit_code: 0,
      timed_out: false,
      usage_reported: true,
      ...timing,
    },
  };
}

const twoAssertionCase = {
  id: 'case-1',
  prompt: 'Do the task',
  expected_output: 'Done',
  files: [],
  assertions: ['Assertion 1', 'Assertion 2'],
};

const baseParams = {
  skillName: 'demo-skill',
  skillPath: '/repo/skills/demo-skill',
  runner: 'fake' as const,
  runsPerConfig: 1,
  cases: [twoAssertionCase],
  timestamp: '2026-04-12T00:00:00.000Z',
};

test('computeStatSummary keeps full precision; rounding happens only when rendering', () => {
  const stat = computeStatSummary([1 / 3, 2 / 3, 1]);

  assert.equal(stat.mean, 2 / 3);
  assert.equal(stat.min, 1 / 3);
  assert.ok(Math.abs(stat.stddev - 1 / 3) < 1e-12);
  assert.notEqual(stat.stddev, 0.3333);
});

test('aggregateBenchmark excludes runs without reported usage from token stats', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: true,
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, true] }),
      makeRun({
        variant: 'with_skill',
        passed: [true, true],
        runIndex: 2,
        timing: { total_tokens: 0, usage_reported: false },
      }),
      makeRun({
        variant: 'without_skill',
        passed: [true, false],
        timing: { total_tokens: 0, usage_reported: false },
      }),
    ],
  });
  const markdown = renderBenchmarkReport(benchmark);

  assert.deepEqual(benchmark.run_summary.with_skill.tokens, {
    mean: 100,
    stddev: 0,
    min: 100,
    max: 100,
  });
  assert.equal(benchmark.run_summary.with_skill.usage_reported_runs, 1);
  assert.equal(benchmark.run_summary.without_skill?.tokens, null);
  assert.equal(benchmark.run_summary.delta?.tokens, 'n/a');
  assert.equal(benchmark.run_summary.delta?.pass_rate, '+0.50');
  assert.match(
    markdown,
    /\| `without_skill` \| 50\.0% ± 0\.0% \| 1\.00 ± 0\.00s \| n\/a \| 0\/1 \|/,
  );
});

test('aggregateBenchmark counts failed and timed-out runs as failures', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: false,
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, true] }),
      makeRun({
        variant: 'with_skill',
        passed: [false, false],
        runIndex: 2,
        timing: { error: 'Runner exited with code 1', exit_code: 1 },
      }),
      makeRun({
        variant: 'with_skill',
        passed: [false, false],
        runIndex: 3,
        timing: { timed_out: true },
      }),
    ],
  });
  const markdown = renderBenchmarkReport(benchmark);

  assert.equal(benchmark.run_summary.with_skill.runs, 3);
  assert.equal(benchmark.run_summary.with_skill.failed_runs, 2);
  assert.equal(benchmark.run_summary.with_skill.pass_rate.mean, 1 / 3);
  assert.match(markdown, /\| `with_skill` \| 33\.3% ± 57\.7% \| .* \| 2\/3 \|/);
  assert.match(markdown, /Run 2 \(0\.0%, 1\.00s, 100 tokens, failed\)/);
  assert.match(markdown, /Run 3 \(0\.0%, 1\.00s, 100 tokens, timed out\)/);
  assert.match(markdown, /\*\*Run error:\*\* Runner exited with code 1/);
});

test('aggregateBenchmark uses a neutral class when there is no reference run', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: false,
    runs: [makeRun({ variant: 'with_skill', passed: [true, false] })],
  });

  assert.deepEqual(
    benchmark.cases[0]?.assertions.map((item) => item.classification),
    ['no-baseline', 'no-baseline'],
  );
  assert.deepEqual(benchmark.assertion_analysis.pass_only_with_skill, []);
  assert.deepEqual(benchmark.assertion_analysis.fail_in_both, []);
  assert.equal(benchmark.run_summary.delta, undefined);
});

test('aggregateBenchmark classifies against without_skill and old_skill separately', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: true,
    compareRef: 'v1',
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, false] }),
      makeRun({ variant: 'without_skill', passed: [false, true] }),
      makeRun({ variant: 'old_skill', passed: [true, true] }),
    ],
  });
  const [first, second] = benchmark.cases[0]?.assertions ?? [];
  const markdown = renderBenchmarkReport(benchmark);

  assert.equal(first?.classification, 'differentiating');
  assert.equal(first?.old_skill_classification, 'non-discriminating');
  assert.equal(second?.classification, 'regressing');
  assert.equal(second?.old_skill_classification, 'regressing');
  assert.deepEqual(benchmark.assertion_analysis.regressing, [
    'case-1: Assertion 2',
  ]);
  assert.deepEqual(benchmark.assertion_analysis.regressing_vs_old, [
    'case-1: Assertion 2',
  ]);
  assert.equal(benchmark.run_summary.old_skill_delta?.pass_rate, '-0.50');
  assert.match(
    markdown,
    /Regressing \(vs baseline\) \(1\):\*\* `case-1: Assertion 2`/,
  );
  assert.match(markdown, /Regressing \(vs `old_skill`\) \(1\)/);
  assert.match(
    markdown,
    /\| \*\*Delta \(vs old_skill\)\*\* \| \*\*-50\.0 pp\*\* \|/,
  );
  assert.match(
    markdown,
    /\| Assertion \| Kind \| `with_skill` \| `without_skill` \| `old_skill` \| Classification \(vs baseline\) \| Classification \(vs `old_skill`\) \|/,
  );
});

test('aggregateBenchmark falls back to old_skill as the reference without a baseline', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: false,
    compareRef: 'v1',
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, false] }),
      makeRun({ variant: 'old_skill', passed: [false, true] }),
    ],
  });

  assert.deepEqual(
    benchmark.cases[0]?.assertions.map((item) => item.classification),
    ['differentiating', 'regressing'],
  );
  assert.deepEqual(benchmark.assertion_analysis.regressing, []);
  assert.deepEqual(benchmark.assertion_analysis.regressing_vs_old, [
    'case-1: Assertion 2',
  ]);
});

test('aggregateTriggerRuns reports undefined ratios as null and renders n/a', () => {
  const summary = aggregateTriggerRuns({
    skillName: 'demo-skill',
    skillPath: '/repo/skills/demo-skill',
    runner: 'fake',
    split: 'all',
    runsPerQuery: 1,
    threshold: 0.5,
    timestamp: '2026-04-12T00:00:00.000Z',
    queries: [{ query: 'near miss', should_trigger: false }],
    results: [
      {
        query: 'near miss',
        should_trigger: false,
        triggered: false,
        duration_ms: 10,
      },
    ],
  });
  const markdown = renderTriggerReport(summary);

  assert.equal(summary.schema_version, 1);
  assert.equal(summary.metrics.recall, null);
  assert.equal(summary.metrics.precision, null);
  assert.equal(summary.metrics.specificity, 1);
  assert.match(markdown, /\| Recall \(Sensitivity\) \| n\/a \(0\/0\) \|/);
  assert.match(markdown, /\| Precision \| n\/a \(0\/0\) \|/);
});

test('loadBenchmarkFromIteration validates benchmark.json with EvalError', async (t) => {
  const dir = await tempDir(t);
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: false,
    runs: [makeRun({ variant: 'with_skill', passed: [true, false] })],
  });
  const write = (value: unknown) =>
    writeFile(join(dir, 'benchmark.json'), JSON.stringify(value));

  await write(benchmark);
  assert.deepEqual(await loadBenchmarkFromIteration(dir), benchmark);

  await write({ ...benchmark, schema_version: undefined });
  await assert.rejects(loadBenchmarkFromIteration(dir), {
    name: 'EvalError',
    message: /schema_version: unsupported schema_version/,
  });

  await write({ ...benchmark, schema_version: 2 });
  await assert.rejects(loadBenchmarkFromIteration(dir), {
    name: 'EvalError',
    message: /unsupported schema_version/,
  });

  await write({ ...benchmark, cases: 'not-a-list' });
  await assert.rejects(loadBenchmarkFromIteration(dir), {
    name: 'EvalError',
    message: /cases/,
  });

  await write({
    ...benchmark,
    run_summary: { ...benchmark.run_summary, with_skill: null },
  });
  await assert.rejects(loadBenchmarkFromIteration(dir), {
    name: 'EvalError',
    message: /run_summary\.with_skill/,
  });

  await writeFile(join(dir, 'benchmark.json'), '{');
  await assert.rejects(loadBenchmarkFromIteration(dir), {
    name: 'EvalError',
    message: /Invalid JSON/,
  });
});

test('loadTriggerSummary validates triggers.json with EvalError', async (t) => {
  const dir = await tempDir(t);
  const summary = aggregateTriggerRuns({
    skillName: 'demo-skill',
    skillPath: '/repo/skills/demo-skill',
    runner: 'fake',
    split: 'all',
    runsPerQuery: 1,
    threshold: 0.5,
    timestamp: '2026-04-12T00:00:00.000Z',
    queries: [{ query: 'q', should_trigger: true }],
    results: [
      { query: 'q', should_trigger: true, triggered: true, duration_ms: 1 },
    ],
  });

  await writeFile(join(dir, 'triggers.json'), JSON.stringify(summary));
  assert.deepEqual(await loadTriggerSummary(dir), summary);

  await writeFile(
    join(dir, 'triggers.json'),
    JSON.stringify({
      ...summary,
      metrics: { ...summary.metrics, recall: '1' },
    }),
  );
  await assert.rejects(loadTriggerSummary(dir), {
    name: 'EvalError',
    message: /metrics\.recall/,
  });
  await assert.rejects(loadTriggerSummary(join(dir, 'missing')), {
    name: 'EvalError',
    message: /Missing triggers\.json/,
  });
});

test('aggregateTriggerRuns leaves failed runs out of trigger rates and metrics', () => {
  const summary = aggregateTriggerRuns({
    skillName: 'demo-skill',
    skillPath: '/repo/skills/demo-skill',
    runner: 'fake',
    split: 'all',
    runsPerQuery: 2,
    threshold: 0.5,
    timestamp: '2026-04-12T00:00:00.000Z',
    queries: [
      { query: 'positive', should_trigger: true },
      { query: 'broken', should_trigger: false },
    ],
    results: [
      {
        query: 'positive',
        should_trigger: true,
        triggered: true,
        duration_ms: 1,
      },
      {
        query: 'positive',
        should_trigger: true,
        triggered: false,
        duration_ms: 1,
        error: 'Timed out',
      },
      {
        query: 'broken',
        should_trigger: false,
        triggered: false,
        duration_ms: 1,
        error: 'Runner exited with code 1',
      },
      {
        query: 'broken',
        should_trigger: false,
        triggered: false,
        duration_ms: 1,
        error: 'Runner exited with code 1',
      },
    ],
  });
  const [positive, broken] = summary.queries;
  const markdown = renderTriggerReport(summary);

  assert.equal(positive?.trigger_rate, 1);
  assert.equal(positive?.errored_runs, 1);
  assert.equal(positive?.passed, true);
  assert.equal(broken?.trigger_rate, null);
  assert.equal(broken?.passed, false);
  assert.equal(summary.metrics.errored_queries, 1);
  assert.equal(summary.metrics.negative_queries, 0);
  assert.equal(summary.metrics.false_positives, 0);
  assert.equal(summary.metrics.specificity, null);
  assert.equal(summary.metrics.accuracy, 1);
  assert.match(
    markdown,
    /\| \*\*PASS\*\* \| `trigger` \| 1\/1 \(100\.0%, 1 failed\) \| positive \|/,
  );
  assert.match(
    markdown,
    /\| \*\*ERROR\*\* \| `no-trigger` \| 0\/0 \(n\/a, 2 failed\) \| broken \|/,
  );
  assert.match(markdown, /Queries with only failed runs \(excluded\) \| 1\/2/);
});

test('old-ref-only reports label old_skill as the reference', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: false,
    compareRef: 'v1',
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, true] }),
      makeRun({ variant: 'old_skill', passed: [false, true] }),
    ],
  });
  const markdown = renderBenchmarkReport(benchmark);

  assert.match(
    markdown,
    /These assertions passed 100% in both `with_skill` and `old_skill` runs:/,
  );
  assert.match(
    markdown,
    /- \*\*Pass only with skill \(vs `old_skill`\) \(1\):\*\* `case-1: Assertion 1`/,
  );
  assert.match(markdown, /- \*\*Pass in both \(vs `old_skill`\) \(1\):\*\*/);
  assert.equal(markdown.includes('baseline runs'), false);
  assert.equal(markdown.includes('(vs baseline)'), false);
  assert.ok(
    markdown
      .split('\n')
      .includes(
        '| Assertion | Kind | `with_skill` | `old_skill` | Classification (vs `old_skill`) |',
      ),
  );
  assert.ok(
    markdown
      .split('\n')
      .includes(
        '| Assertion 1 | `string` | 100.0% | 0.0% | `differentiating` |',
      ),
  );
});

test('with_skill shadowing is reported apart from the baseline status', () => {
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: true,
    possiblyContaminated: false,
    withSkillContaminated: true,
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, true] }),
      makeRun({ variant: 'without_skill', passed: [false, true] }),
    ],
  });
  const markdown = renderBenchmarkReport(benchmark);

  assert.equal(benchmark.metadata.baseline_status, 'clean');
  assert.equal(benchmark.metadata.with_skill_contaminated, true);
  assert.match(markdown, /- \*\*Baseline status:\*\* clean/);
  assert.match(
    markdown,
    /- \*\*`with_skill` status:\*\* possibly contaminated/,
  );
});

test('aggregateBenchmark and renderBenchmarkReport include compared skills and deltas in benchmark.json and report.md', async (t) => {
  const dir = await tempDir(t);
  const benchmark = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: true,
    compareSkills: ['skill-b', 'skill-c'],
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, false] }),
      makeRun({ variant: 'without_skill', passed: [false, false] }),
      makeRun({ variant: 'compare:skill-b', passed: [true, false] }),
      makeRun({ variant: 'compare:skill-c', passed: [false, true] }),
    ],
  });
  const noBaselineCompare = aggregateBenchmark({
    ...baseParams,
    baselineEnabled: false,
    compareSkills: ['skill-b'],
    runs: [
      makeRun({ variant: 'with_skill', passed: [true, false] }),
      makeRun({ variant: 'compare:skill-b', passed: [true, true] }),
    ],
  });

  await writeFile(join(dir, 'benchmark.json'), JSON.stringify(benchmark));
  const reloaded = await loadBenchmarkFromIteration(dir);
  const markdown = renderBenchmarkReport(benchmark);
  const noBaselineMarkdown = renderBenchmarkReport(noBaselineCompare);

  assert.deepEqual(reloaded, benchmark);
  assert.deepEqual(benchmark.metadata.compare_skills, ['skill-b', 'skill-c']);
  assert.equal(
    benchmark.run_summary.compare_skills?.['skill-b']?.pass_rate.mean,
    0.5,
  );
  assert.equal(
    benchmark.run_summary.compare_deltas?.['skill-b']?.pass_rate,
    '+0.00',
  );
  assert.deepEqual(benchmark.cases[0]?.assertions[0]?.compare_pass_rates, {
    'skill-b': 1,
    'skill-c': 0,
  });
  assert.deepEqual(benchmark.cases[0]?.assertions[0]?.compare_classifications, {
    'skill-b': 'non-discriminating',
    'skill-c': 'differentiating',
  });
  assert.deepEqual(benchmark.cases[0]?.assertions[1]?.compare_classifications, {
    'skill-b': 'failing',
    'skill-c': 'regressing',
  });
  assert.deepEqual(benchmark.assertion_analysis.regressing_vs_compare, {
    'skill-b': [],
    'skill-c': ['case-1: Assertion 2'],
  });
  assert.deepEqual(noBaselineCompare.assertion_analysis.regressing, [
    'case-1: Assertion 2',
  ]);
  assert.deepEqual(noBaselineCompare.assertion_analysis.regressing_vs_compare, {
    'skill-b': ['case-1: Assertion 2'],
  });
  assert.match(
    markdown,
    /- \*\*Compared against skills:\*\* `skill-b`, `skill-c`/,
  );
  assert.match(markdown, /\| `compare:skill-b` \| 50\.0% ± 0\.0% \|/);
  assert.match(
    markdown,
    /\| \*\*Delta \(vs skill-b\)\*\* \| \*\*\+0\.0 pp\*\* \|/,
  );
  assert.match(
    markdown,
    /\| Assertion \| Kind \| `with_skill` \| `without_skill` \| `compare:skill-b` \| `compare:skill-c` \| Classification \(vs baseline\) \| Classification \(vs `compare:skill-b`\) \| Classification \(vs `compare:skill-c`\) \|/,
  );
  assert.match(
    markdown,
    /- \*\*Regressing \(vs `compare:skill-c`\) \(1\):\*\* `case-1: Assertion 2`/,
  );
  assert.match(
    noBaselineMarkdown,
    /These assertions passed 100% in both `with_skill` and `compare:skill-b` runs:/,
  );
  assert.match(noBaselineMarkdown, /Classification \(vs `compare:skill-b`\)/);
  assert.match(
    noBaselineMarkdown,
    /- \*\*Regressing \(vs `compare:skill-b`\) \(1\):\*\* `case-1: Assertion 2`/,
  );
});
