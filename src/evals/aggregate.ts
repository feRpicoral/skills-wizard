import { join } from 'node:path';

import { z } from 'zod';

import { EvalError } from '../errors.ts';
import { readTextIfExists } from '../install/fs.ts';
import type { EvalCase, TriggerQuery, TriggerSplit } from './cases.ts';
import {
  formatAssertionLabel,
  type GradingReport,
  type TimingReport,
} from './grade.ts';
import type { EvalRunnerName, EvalVariant } from './workspace.ts';

/** Version of the `benchmark.json` and `triggers.json` formats. */
export const EVAL_SCHEMA_VERSION = 1;

export interface StatSummary {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface VariantAggregate {
  /** Number of runs aggregated, failed runs included. */
  runs: number;
  /** Runs where the agent timed out or failed; they count as failures. */
  failed_runs: number;
  /** Runs whose token usage was reported and is included in `tokens`. */
  usage_reported_runs: number;
  pass_rate: StatSummary;
  time_seconds: StatSummary;
  /** `null` when no run reported token usage. */
  tokens: StatSummary | null;
}

export interface DeltaSummary {
  /** Signed difference of mean pass rates as a fraction, e.g. "+0.33". */
  pass_rate: string;
  /** Signed difference of mean durations in seconds, e.g. "+12.40". */
  time_seconds: string;
  /** Signed difference of mean token counts, or "n/a" without usage. */
  tokens: string;
}

export type AssertionClassification =
  | 'differentiating'
  | 'non-discriminating'
  | 'regressing'
  | 'failing'
  | 'flaky'
  | 'no-baseline';

export interface AssertionAggregate {
  text: string;
  kind: string;
  with_skill_pass_rate: number;
  baseline_pass_rate?: number;
  old_skill_pass_rate?: number;
  /**
   * Compared with `without_skill`, or with `old_skill` when the eval ran no
   * baseline; `no-baseline` when there is neither.
   */
  classification: AssertionClassification;
  /** Compared with `old_skill`; present only with `--compare`. */
  old_skill_classification?: AssertionClassification;
}

export interface AssertionAnalysis {
  pass_only_with_skill: string[];
  pass_in_both: string[];
  fail_in_both: string[];
  flaky: string[];
  /** Assertions that pass less often with the skill than without it. */
  regressing: string[];
  /** Assertions that pass less often with the skill than with `old_skill`. */
  regressing_vs_old: string[];
}

export interface EvalRunRecord {
  case_id: string;
  prompt: string;
  variant: EvalVariant;
  run_index: number;
  grading: GradingReport;
  timing: TimingReport;
}

export interface CaseBenchmarkSummary {
  case_id: string;
  prompt: string;
  expected_output: string;
  variants: Partial<Record<EvalVariant, VariantAggregate>>;
  assertions: AssertionAggregate[];
  runs: EvalRunRecord[];
}

export type BaselineStatus = 'clean' | 'possibly contaminated' | 'skipped';

export interface BenchmarkMetadata {
  skill_name: string;
  skill_path: string;
  runner: EvalRunnerName;
  timestamp: string;
  runs_per_configuration: number;
  compare_ref?: string;
  baseline_status: BaselineStatus;
  warnings: string[];
}

export interface BenchmarkRunSummary {
  with_skill: VariantAggregate;
  without_skill?: VariantAggregate;
  old_skill?: VariantAggregate;
  delta?: DeltaSummary;
  old_skill_delta?: DeltaSummary;
}

export interface BenchmarkSummary {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  metadata: BenchmarkMetadata;
  run_summary: BenchmarkRunSummary;
  cases: CaseBenchmarkSummary[];
  non_discriminating_assertions: string[];
  assertion_analysis: AssertionAnalysis;
}

export interface TriggerQueryRunResult {
  query: string;
  should_trigger: boolean;
  triggered: boolean;
  duration_ms: number;
  /** Why the run failed; failed runs are left out of the trigger rate. */
  error?: string;
}

export interface TriggerQueryAggregate {
  query: string;
  should_trigger: boolean;
  trigger_count: number;
  /** Runs recorded for the query, failed runs included. */
  runs: number;
  errored_runs: number;
  /** Share of successful runs that triggered; `null` when every run failed. */
  trigger_rate: number | null;
  passed: boolean;
}

/**
 * Ratios are `null` when their denominator is zero. Queries whose runs all
 * failed are counted in `errored_queries` and left out of every other count.
 */
export interface TriggerMetrics {
  total_queries: number;
  errored_queries: number;
  positive_queries: number;
  negative_queries: number;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  recall: number | null;
  precision: number | null;
  specificity: number | null;
  false_positive_rate: number | null;
  accuracy: number | null;
}

export interface TriggerBenchmarkSummary {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  metadata: {
    skill_name: string;
    skill_path: string;
    runner: EvalRunnerName;
    split: TriggerSplit;
    runs_per_query: number;
    threshold: number;
    timestamp: string;
  };
  metrics: TriggerMetrics;
  queries: TriggerQueryAggregate[];
}

/** Statistics are stored unrounded; rounding happens only when rendering. */
export function computeStatSummary(values: readonly number[]): StatSummary {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }
  const sum = values.reduce((acc, val) => acc + val, 0);
  const mean = sum / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (values.length === 1) {
    return { mean, stddev: 0, min, max };
  }
  const variance =
    values.reduce((acc, val) => acc + (val - mean) ** 2, 0) /
    (values.length - 1);
  return { mean, stddev: Math.sqrt(variance), min, max };
}

/** A run failed when the agent timed out or the runner reported an error. */
export function isFailedRun(run: EvalRunRecord): boolean {
  return run.timing.timed_out || Boolean(run.timing.error);
}

export function aggregateVariantRuns(
  runs: readonly EvalRunRecord[],
): VariantAggregate {
  const reported = runs.filter((item) => item.timing.usage_reported !== false);
  return {
    runs: runs.length,
    failed_runs: runs.filter(isFailedRun).length,
    usage_reported_runs: reported.length,
    pass_rate: computeStatSummary(
      runs.map((item) => item.grading.summary.pass_rate),
    ),
    time_seconds: computeStatSummary(
      runs.map((item) => item.timing.total_duration_seconds),
    ),
    tokens:
      reported.length > 0
        ? computeStatSummary(reported.map((item) => item.timing.total_tokens))
        : null,
  };
}

interface ComputeDeltaParams {
  primary: VariantAggregate;
  reference: VariantAggregate;
}

interface FormatSignedDeltaParams {
  value: number;
  decimals: number;
}

export function formatSignedDelta({
  value,
  decimals,
}: FormatSignedDeltaParams): string {
  const fixed = value.toFixed(decimals);
  // Avoid "-0.00" for values that round to zero.
  if (Number(fixed) === 0) return `+${(0).toFixed(decimals)}`;
  return value > 0 ? `+${fixed}` : fixed;
}

export function computeVariantDelta({
  primary,
  reference,
}: ComputeDeltaParams): DeltaSummary {
  return {
    pass_rate: formatSignedDelta({
      value: primary.pass_rate.mean - reference.pass_rate.mean,
      decimals: 2,
    }),
    time_seconds: formatSignedDelta({
      value: primary.time_seconds.mean - reference.time_seconds.mean,
      decimals: 2,
    }),
    tokens:
      primary.tokens && reference.tokens
        ? formatSignedDelta({
            value: primary.tokens.mean - reference.tokens.mean,
            decimals: 0,
          })
        : 'n/a',
  };
}

interface ClassifyAssertionParams {
  withSkillRate: number;
  referenceRate?: number;
}

function isPartialRate(rate: number | undefined): boolean {
  return rate !== undefined && rate > 0 && rate < 1;
}

export function classifyAssertion({
  withSkillRate,
  referenceRate,
}: ClassifyAssertionParams): AssertionClassification {
  if (referenceRate === undefined) {
    return 'no-baseline';
  }
  if (isPartialRate(withSkillRate) || isPartialRate(referenceRate)) {
    return 'flaky';
  }
  if (withSkillRate === 1 && referenceRate === 1) {
    return 'non-discriminating';
  }
  if (withSkillRate > referenceRate) {
    return 'differentiating';
  }
  if (withSkillRate < referenceRate) {
    return 'regressing';
  }
  return 'failing';
}

interface AggregateCaseAssertionsParams {
  evalCase: EvalCase;
  caseRuns: readonly EvalRunRecord[];
}

function aggregateCaseAssertions({
  evalCase,
  caseRuns,
}: AggregateCaseAssertionsParams): AssertionAggregate[] {
  const withRuns = caseRuns.filter((run) => run.variant === 'with_skill');
  const withoutRuns = caseRuns.filter((run) => run.variant === 'without_skill');
  const oldRuns = caseRuns.filter((run) => run.variant === 'old_skill');

  return evalCase.assertions.map((assertion, assertionIndex) => {
    const label = formatAssertionLabel(assertion);
    const kind = typeof assertion === 'string' ? 'string' : assertion.type;

    const rateFor = (runs: readonly EvalRunRecord[]): number | undefined => {
      if (runs.length === 0) return undefined;
      const passedCount = runs.filter(
        (run) => run.grading.expectations[assertionIndex]?.passed === true,
      ).length;
      return passedCount / runs.length;
    };

    const withRate = rateFor(withRuns) ?? 0;
    const withoutRate = rateFor(withoutRuns);
    const oldRate = rateFor(oldRuns);

    return {
      text: label,
      kind,
      with_skill_pass_rate: withRate,
      ...(withoutRate !== undefined ? { baseline_pass_rate: withoutRate } : {}),
      ...(oldRate !== undefined ? { old_skill_pass_rate: oldRate } : {}),
      classification: classifyAssertion({
        withSkillRate: withRate,
        referenceRate: withoutRate ?? oldRate,
      }),
      ...(oldRate !== undefined
        ? {
            old_skill_classification: classifyAssertion({
              withSkillRate: withRate,
              referenceRate: oldRate,
            }),
          }
        : {}),
    };
  });
}

export interface AggregateBenchmarkParams {
  skillName: string;
  skillPath: string;
  runner: EvalRunnerName;
  runsPerConfig: number;
  cases: readonly EvalCase[];
  runs: readonly EvalRunRecord[];
  baselineEnabled: boolean;
  possiblyContaminated?: boolean;
  compareRef?: string;
  warnings?: readonly string[];
  timestamp?: string;
}

export function aggregateBenchmark({
  skillName,
  skillPath,
  runner,
  runsPerConfig,
  cases,
  runs,
  baselineEnabled,
  possiblyContaminated = false,
  compareRef,
  warnings = [],
  timestamp = new Date().toISOString(),
}: AggregateBenchmarkParams): BenchmarkSummary {
  const withRuns = runs.filter((run) => run.variant === 'with_skill');
  const withoutRuns = runs.filter((run) => run.variant === 'without_skill');
  const oldRuns = runs.filter((run) => run.variant === 'old_skill');

  const withAggregate = aggregateVariantRuns(withRuns);
  const withoutAggregate =
    withoutRuns.length > 0 ? aggregateVariantRuns(withoutRuns) : undefined;
  const oldAggregate =
    oldRuns.length > 0 ? aggregateVariantRuns(oldRuns) : undefined;

  const caseSummaries: CaseBenchmarkSummary[] = cases.map((evalCase) => {
    const caseRuns = runs.filter((run) => run.case_id === evalCase.id);
    const variants: Partial<Record<EvalVariant, VariantAggregate>> = {};
    for (const variant of [
      'with_skill',
      'without_skill',
      'old_skill',
    ] as const) {
      const vRuns = caseRuns.filter((run) => run.variant === variant);
      if (vRuns.length > 0) {
        variants[variant] = aggregateVariantRuns(vRuns);
      }
    }
    return {
      case_id: evalCase.id,
      prompt: evalCase.prompt,
      expected_output: evalCase.expected_output,
      variants,
      assertions: aggregateCaseAssertions({ evalCase, caseRuns }),
      runs: caseRuns,
    };
  });

  const nonDiscriminating: string[] = [];
  const passOnlyWithSkill: string[] = [];
  const passInBoth: string[] = [];
  const failInBoth: string[] = [];
  const flaky: string[] = [];
  const regressing: string[] = [];
  const regressingVsOld: string[] = [];

  for (const caseSummary of caseSummaries) {
    for (const assertion of caseSummary.assertions) {
      const entry = `${caseSummary.case_id}: ${assertion.text}`;
      if (assertion.classification === 'non-discriminating') {
        nonDiscriminating.push(entry);
        passInBoth.push(entry);
      } else if (assertion.classification === 'differentiating') {
        passOnlyWithSkill.push(entry);
      } else if (assertion.classification === 'failing') {
        failInBoth.push(entry);
      } else if (assertion.classification === 'flaky') {
        flaky.push(entry);
      }
      if (
        assertion.baseline_pass_rate !== undefined &&
        assertion.classification === 'regressing'
      ) {
        regressing.push(entry);
      }
      if (assertion.old_skill_classification === 'regressing') {
        regressingVsOld.push(entry);
      }
    }
  }

  const baselineStatus: BaselineStatus = !baselineEnabled
    ? 'skipped'
    : possiblyContaminated
      ? 'possibly contaminated'
      : 'clean';

  return {
    schema_version: EVAL_SCHEMA_VERSION,
    metadata: {
      skill_name: skillName,
      skill_path: skillPath,
      runner,
      timestamp,
      runs_per_configuration: runsPerConfig,
      ...(compareRef ? { compare_ref: compareRef } : {}),
      baseline_status: baselineStatus,
      warnings: [...warnings],
    },
    run_summary: {
      with_skill: withAggregate,
      ...(withoutAggregate ? { without_skill: withoutAggregate } : {}),
      ...(oldAggregate ? { old_skill: oldAggregate } : {}),
      ...(withoutAggregate
        ? {
            delta: computeVariantDelta({
              primary: withAggregate,
              reference: withoutAggregate,
            }),
          }
        : {}),
      ...(oldAggregate
        ? {
            old_skill_delta: computeVariantDelta({
              primary: withAggregate,
              reference: oldAggregate,
            }),
          }
        : {}),
    },
    cases: caseSummaries,
    non_discriminating_assertions: nonDiscriminating,
    assertion_analysis: {
      pass_only_with_skill: passOnlyWithSkill,
      pass_in_both: passInBoth,
      fail_in_both: failInBoth,
      flaky,
      regressing,
      regressing_vs_old: regressingVsOld,
    },
  };
}

export interface AggregateTriggerRunsParams {
  skillName: string;
  skillPath: string;
  runner: EvalRunnerName;
  split: TriggerSplit;
  runsPerQuery: number;
  threshold: number;
  queries: readonly TriggerQuery[];
  results: readonly TriggerQueryRunResult[];
  timestamp?: string;
}

interface RatioParams {
  numerator: number;
  denominator: number;
}

function ratio({ numerator, denominator }: RatioParams): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function aggregateTriggerRuns({
  skillName,
  skillPath,
  runner,
  split,
  runsPerQuery,
  threshold,
  queries,
  results,
  timestamp = new Date().toISOString(),
}: AggregateTriggerRunsParams): TriggerBenchmarkSummary {
  const queryAggregates: TriggerQueryAggregate[] = queries.map((item) => {
    const qRuns = results.filter((res) => res.query === item.query);
    const okRuns = qRuns.filter((res) => !res.error);
    const triggerCount = okRuns.filter((res) => res.triggered).length;
    const triggerRate =
      okRuns.length === 0 ? null : triggerCount / okRuns.length;
    const passed =
      triggerRate !== null &&
      (item.should_trigger
        ? triggerRate >= threshold
        : triggerRate < threshold);
    return {
      query: item.query,
      should_trigger: item.should_trigger,
      trigger_count: triggerCount,
      runs: qRuns.length,
      errored_runs: qRuns.length - okRuns.length,
      trigger_rate: triggerRate,
      passed,
    };
  });

  const evaluated = queryAggregates.filter((q) => q.trigger_rate !== null);
  const positives = evaluated.filter((q) => q.should_trigger);
  const negatives = evaluated.filter((q) => !q.should_trigger);

  const tp = positives.filter((q) => q.passed).length;
  const fn = positives.length - tp;
  const tn = negatives.filter((q) => q.passed).length;
  const fp = negatives.length - tn;

  return {
    schema_version: EVAL_SCHEMA_VERSION,
    metadata: {
      skill_name: skillName,
      skill_path: skillPath,
      runner,
      split,
      runs_per_query: runsPerQuery,
      threshold,
      timestamp,
    },
    metrics: {
      total_queries: queryAggregates.length,
      errored_queries: queryAggregates.length - evaluated.length,
      positive_queries: positives.length,
      negative_queries: negatives.length,
      true_positives: tp,
      false_positives: fp,
      true_negatives: tn,
      false_negatives: fn,
      recall: ratio({ numerator: tp, denominator: positives.length }),
      precision: ratio({ numerator: tp, denominator: tp + fp }),
      specificity: ratio({ numerator: tn, denominator: negatives.length }),
      false_positive_rate: ratio({
        numerator: fp,
        denominator: negatives.length,
      }),
      accuracy: ratio({
        numerator: tp + tn,
        denominator: evaluated.length,
      }),
    },
    queries: queryAggregates,
  };
}

const RUNNER_NAMES = ['agy', 'claude', 'codex', 'gemini', 'fake'] as const;
const VARIANTS = ['with_skill', 'without_skill', 'old_skill'] as const;
const CLASSIFICATIONS = [
  'differentiating',
  'non-discriminating',
  'regressing',
  'failing',
  'flaky',
  'no-baseline',
] as const;

const schemaVersionSchema = z.literal(EVAL_SCHEMA_VERSION, {
  error: `unsupported schema_version (expected ${EVAL_SCHEMA_VERSION})`,
});

const statSummarySchema = z.looseObject({
  mean: z.number(),
  stddev: z.number(),
  min: z.number(),
  max: z.number(),
});

const variantAggregateSchema = z.looseObject({
  runs: z.number().int().nonnegative(),
  failed_runs: z.number().int().nonnegative(),
  usage_reported_runs: z.number().int().nonnegative(),
  pass_rate: statSummarySchema,
  time_seconds: statSummarySchema,
  tokens: statSummarySchema.nullable(),
});

const deltaSummarySchema = z.looseObject({
  pass_rate: z.string(),
  time_seconds: z.string(),
  tokens: z.string(),
});

const runRecordSchema = z.looseObject({
  case_id: z.string(),
  prompt: z.string(),
  variant: z.enum(VARIANTS),
  run_index: z.number().int(),
  grading: z.looseObject({
    expectations: z.array(
      z.looseObject({
        text: z.string(),
        kind: z.string(),
        passed: z.boolean(),
        evidence: z.string(),
      }),
    ),
    summary: z.looseObject({
      passed: z.number(),
      failed: z.number(),
      total: z.number(),
      pass_rate: z.number(),
    }),
  }),
  timing: z.looseObject({
    total_duration_seconds: z.number(),
    total_tokens: z.number(),
    timed_out: z.boolean(),
    usage_reported: z.boolean().optional(),
    error: z.string().optional(),
  }),
});

const assertionAggregateSchema = z.looseObject({
  text: z.string(),
  kind: z.string(),
  with_skill_pass_rate: z.number(),
  baseline_pass_rate: z.number().optional(),
  old_skill_pass_rate: z.number().optional(),
  classification: z.enum(CLASSIFICATIONS),
  old_skill_classification: z.enum(CLASSIFICATIONS).optional(),
});

const benchmarkSummarySchema = z.looseObject({
  schema_version: schemaVersionSchema,
  metadata: z.looseObject({
    skill_name: z.string(),
    skill_path: z.string(),
    runner: z.enum(RUNNER_NAMES),
    timestamp: z.string(),
    runs_per_configuration: z.number().int(),
    compare_ref: z.string().optional(),
    baseline_status: z.enum(['clean', 'possibly contaminated', 'skipped']),
    warnings: z.array(z.string()),
  }),
  run_summary: z.looseObject({
    with_skill: variantAggregateSchema,
    without_skill: variantAggregateSchema.optional(),
    old_skill: variantAggregateSchema.optional(),
    delta: deltaSummarySchema.optional(),
    old_skill_delta: deltaSummarySchema.optional(),
  }),
  cases: z.array(
    z.looseObject({
      case_id: z.string(),
      prompt: z.string(),
      expected_output: z.string(),
      variants: z.partialRecord(z.enum(VARIANTS), variantAggregateSchema),
      assertions: z.array(assertionAggregateSchema),
      runs: z.array(runRecordSchema),
    }),
  ),
  non_discriminating_assertions: z.array(z.string()),
  assertion_analysis: z.looseObject({
    pass_only_with_skill: z.array(z.string()),
    pass_in_both: z.array(z.string()),
    fail_in_both: z.array(z.string()),
    flaky: z.array(z.string()),
    regressing: z.array(z.string()),
    regressing_vs_old: z.array(z.string()),
  }),
});

const nullableRatioSchema = z.number().nullable();

const triggerBenchmarkSummarySchema = z.looseObject({
  schema_version: schemaVersionSchema,
  metadata: z.looseObject({
    skill_name: z.string(),
    skill_path: z.string(),
    runner: z.enum(RUNNER_NAMES),
    split: z.enum(['train', 'validation', 'all']),
    runs_per_query: z.number().int(),
    threshold: z.number(),
    timestamp: z.string(),
  }),
  metrics: z.looseObject({
    total_queries: z.number().int(),
    errored_queries: z.number().int(),
    positive_queries: z.number().int(),
    negative_queries: z.number().int(),
    true_positives: z.number().int(),
    false_positives: z.number().int(),
    true_negatives: z.number().int(),
    false_negatives: z.number().int(),
    recall: nullableRatioSchema,
    precision: nullableRatioSchema,
    specificity: nullableRatioSchema,
    false_positive_rate: nullableRatioSchema,
    accuracy: nullableRatioSchema,
  }),
  queries: z.array(
    z.looseObject({
      query: z.string(),
      should_trigger: z.boolean(),
      trigger_count: z.number().int(),
      runs: z.number().int(),
      errored_runs: z.number().int(),
      trigger_rate: z.number().nullable(),
      passed: z.boolean(),
    }),
  ),
});

interface ParseSummaryParams {
  raw: unknown;
  sourcePath: string;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}

/** Validates a parsed `benchmark.json`, throwing an `EvalError` if invalid. */
export function parseBenchmarkSummary({
  raw,
  sourcePath,
}: ParseSummaryParams): BenchmarkSummary {
  const result = benchmarkSummarySchema.safeParse(raw);
  if (!result.success) {
    throw new EvalError(
      `Invalid benchmark in ${sourcePath}: ${describeIssues(result.error)}`,
    );
  }
  return result.data as unknown as BenchmarkSummary;
}

/** Validates a parsed `triggers.json`, throwing an `EvalError` if invalid. */
export function parseTriggerBenchmarkSummary({
  raw,
  sourcePath,
}: ParseSummaryParams): TriggerBenchmarkSummary {
  const result = triggerBenchmarkSummarySchema.safeParse(raw);
  if (!result.success) {
    throw new EvalError(
      `Invalid trigger summary in ${sourcePath}: ${describeIssues(result.error)}`,
    );
  }
  return result.data;
}

async function readJsonFile(path: string, dir: string): Promise<unknown> {
  const content = await readTextIfExists(path);
  if (content === null) {
    throw new EvalError(`Missing ${path.slice(dir.length + 1)} in ${dir}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new EvalError(`Invalid JSON in ${path}`, { cause: error });
  }
}

export async function loadBenchmarkFromIteration(
  iterationDir: string,
): Promise<BenchmarkSummary> {
  const benchmarkPath = join(iterationDir, 'benchmark.json');
  return parseBenchmarkSummary({
    raw: await readJsonFile(benchmarkPath, iterationDir),
    sourcePath: benchmarkPath,
  });
}

export async function loadTriggerSummary(
  outputDir: string,
): Promise<TriggerBenchmarkSummary> {
  const summaryPath = join(outputDir, 'triggers.json');
  return parseTriggerBenchmarkSummary({
    raw: await readJsonFile(summaryPath, outputDir),
    sourcePath: summaryPath,
  });
}
