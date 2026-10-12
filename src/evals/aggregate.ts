import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EvalError } from '../errors.ts';
import { readTextIfExists } from '../install/fs.ts';
import type { EvalCase, TriggerQuery, TriggerSplit } from './cases.ts';
import {
  formatAssertionLabel,
  type GradingReport,
  type TimingReport,
} from './grade.ts';
import type { EvalRunnerName, EvalVariant } from './workspace.ts';

export interface StatSummary {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface VariantAggregate {
  pass_rate: StatSummary;
  time_seconds: StatSummary;
  tokens: StatSummary;
}

export interface DeltaSummary {
  pass_rate: string;
  time_seconds: string;
  tokens: string;
}

export type AssertionClassification =
  'differentiating' | 'non-discriminating' | 'regressing' | 'failing';

export interface AssertionAggregate {
  text: string;
  kind: string;
  with_skill_pass_rate: number;
  baseline_pass_rate?: number;
  old_skill_pass_rate?: number;
  classification: AssertionClassification;
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
  metadata: BenchmarkMetadata;
  run_summary: BenchmarkRunSummary;
  cases: CaseBenchmarkSummary[];
  non_discriminating_assertions: string[];
}

export interface TriggerQueryRunResult {
  query: string;
  should_trigger: boolean;
  triggered: boolean;
  duration_ms: number;
}

export interface TriggerQueryAggregate {
  query: string;
  should_trigger: boolean;
  trigger_count: number;
  runs: number;
  trigger_rate: number;
  passed: boolean;
}

export interface TriggerMetrics {
  total_queries: number;
  positive_queries: number;
  negative_queries: number;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  recall: number;
  precision: number;
  specificity: number;
  false_positive_rate: number;
  accuracy: number;
}

export interface TriggerBenchmarkSummary {
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

function roundStat(value: number): number {
  return Number(value.toFixed(4));
}

export function computeStatSummary(values: readonly number[]): StatSummary {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }
  const sum = values.reduce((acc, val) => acc + val, 0);
  const mean = sum / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (values.length === 1) {
    return {
      mean: roundStat(mean),
      stddev: 0,
      min: roundStat(min),
      max: roundStat(max),
    };
  }
  const variance =
    values.reduce((acc, val) => acc + (val - mean) ** 2, 0) /
    (values.length - 1);
  return {
    mean: roundStat(mean),
    stddev: roundStat(Math.sqrt(variance)),
    min: roundStat(min),
    max: roundStat(max),
  };
}

export function aggregateVariantRuns(
  runs: readonly EvalRunRecord[],
): VariantAggregate {
  return {
    pass_rate: computeStatSummary(
      runs.map((item) => item.grading.summary.pass_rate),
    ),
    time_seconds: computeStatSummary(
      runs.map((item) => item.timing.total_duration_seconds),
    ),
    tokens: computeStatSummary(runs.map((item) => item.timing.total_tokens)),
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

function formatSignedDelta({
  value,
  decimals,
}: FormatSignedDeltaParams): string {
  const rounded = Number(value.toFixed(decimals));
  const fixed = rounded.toFixed(decimals);
  return rounded >= 0 ? `+${fixed}` : fixed;
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
    tokens: formatSignedDelta({
      value: Math.round(primary.tokens.mean - reference.tokens.mean),
      decimals: 0,
    }),
  };
}

interface ClassifyAssertionParams {
  withSkillRate: number;
  baselineRate?: number;
}

function classifyAssertion({
  withSkillRate,
  baselineRate,
}: ClassifyAssertionParams): AssertionClassification {
  if (baselineRate === undefined) {
    return withSkillRate === 1 ? 'differentiating' : 'failing';
  }
  if (withSkillRate === 1 && baselineRate === 1) {
    return 'non-discriminating';
  }
  if (withSkillRate > baselineRate) {
    return 'differentiating';
  }
  if (withSkillRate < baselineRate) {
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
      return roundStat(passedCount / runs.length);
    };

    const withRate = rateFor(withRuns) ?? 0;
    const withoutRate = rateFor(withoutRuns);
    const oldRate = rateFor(oldRuns);
    const referenceRate = withoutRate ?? oldRate;

    return {
      text: label,
      kind,
      with_skill_pass_rate: withRate,
      ...(withoutRate !== undefined ? { baseline_pass_rate: withoutRate } : {}),
      ...(oldRate !== undefined ? { old_skill_pass_rate: oldRate } : {}),
      classification: classifyAssertion({
        withSkillRate: withRate,
        baselineRate: referenceRate,
      }),
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
  for (const caseSummary of caseSummaries) {
    for (const assertion of caseSummary.assertions) {
      if (assertion.classification === 'non-discriminating') {
        nonDiscriminating.push(`${caseSummary.case_id}: ${assertion.text}`);
      }
    }
  }

  const baselineStatus: BaselineStatus = !baselineEnabled
    ? 'skipped'
    : possiblyContaminated
      ? 'possibly contaminated'
      : 'clean';

  return {
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
    const triggerCount = qRuns.filter((res) => res.triggered).length;
    const totalRuns = qRuns.length || 1;
    const triggerRate = roundStat(triggerCount / totalRuns);
    const passed = item.should_trigger
      ? triggerRate >= threshold
      : triggerRate < threshold;
    return {
      query: item.query,
      should_trigger: item.should_trigger,
      trigger_count: triggerCount,
      runs: qRuns.length,
      trigger_rate: triggerRate,
      passed,
    };
  });

  const positives = queryAggregates.filter((q) => q.should_trigger);
  const negatives = queryAggregates.filter((q) => !q.should_trigger);

  const tp = positives.filter((q) => q.passed).length;
  const fn = positives.length - tp;
  const tn = negatives.filter((q) => q.passed).length;
  const fp = negatives.length - tn;

  const recall = positives.length === 0 ? 1 : roundStat(tp / positives.length);
  const precision = tp + fp === 0 ? 1 : roundStat(tp / (tp + fp));
  const specificity =
    negatives.length === 0 ? 1 : roundStat(tn / negatives.length);
  const fpr = negatives.length === 0 ? 0 : roundStat(fp / negatives.length);
  const accuracy =
    queryAggregates.length === 0
      ? 1
      : roundStat((tp + tn) / queryAggregates.length);

  return {
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
      positive_queries: positives.length,
      negative_queries: negatives.length,
      true_positives: tp,
      false_positives: fp,
      true_negatives: tn,
      false_negatives: fn,
      recall,
      precision,
      specificity,
      false_positive_rate: fpr,
      accuracy,
    },
    queries: queryAggregates,
  };
}

export async function loadBenchmarkFromIteration(
  iterationDir: string,
): Promise<BenchmarkSummary> {
  const benchmarkPath = join(iterationDir, 'benchmark.json');
  const content = await readTextIfExists(benchmarkPath);
  if (content === null) {
    throw new EvalError(`Missing benchmark.json in ${iterationDir}`);
  }
  try {
    return JSON.parse(readFileSyncOrText(content)) as BenchmarkSummary;
  } catch (error) {
    throw new EvalError(`Invalid JSON in ${benchmarkPath}`, { cause: error });
  }
}

function readFileSyncOrText(content: string): string {
  return content;
}

export async function readBenchmarkJsonFile(
  filePath: string,
): Promise<BenchmarkSummary> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as BenchmarkSummary;
}
