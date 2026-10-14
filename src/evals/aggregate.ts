import {
  EVAL_SCHEMA_VERSION,
  loadBenchmarkFromIteration,
  loadTriggerSummary,
  parseBenchmarkSummary,
  type ParseSummaryParams,
  parseTriggerBenchmarkSummary,
} from './artifacts.ts';
import {
  aggregateCaseAssertions,
  type AssertionAggregate,
  type AssertionAnalysis,
  type AssertionClassification,
  buildAssertionAnalysis,
  type CaseBenchmarkSummary,
  classifyAssertion,
  type DeltaSummary,
  type EvalRunRecord,
  type StatSummary,
  type VariantAggregate,
} from './assertion-analysis.ts';
import type { EvalCase } from './cases.ts';
import {
  aggregateTriggerRuns,
  type AggregateTriggerRunsParams,
  type TriggerBenchmarkSummary,
  type TriggerMetrics,
  type TriggerQueryAggregate,
  type TriggerQueryRunResult,
} from './trigger-aggregate.ts';
import {
  compareSkillVariant,
  type EvalRunnerName,
  type EvalVariant,
  parseCompareSkillVariant,
} from './workspace.ts';

export {
  aggregateCaseAssertions,
  aggregateTriggerRuns,
  type AggregateTriggerRunsParams,
  type AssertionAggregate,
  type AssertionAnalysis,
  type AssertionClassification,
  buildAssertionAnalysis,
  type CaseBenchmarkSummary,
  classifyAssertion,
  type DeltaSummary,
  EVAL_SCHEMA_VERSION,
  type EvalRunRecord,
  loadBenchmarkFromIteration,
  loadTriggerSummary,
  parseBenchmarkSummary,
  type ParseSummaryParams,
  parseTriggerBenchmarkSummary,
  type StatSummary,
  type TriggerBenchmarkSummary,
  type TriggerMetrics,
  type TriggerQueryAggregate,
  type TriggerQueryRunResult,
  type VariantAggregate,
};

export type BaselineStatus = 'clean' | 'possibly contaminated' | 'skipped';

export interface BenchmarkMetadata {
  skill_name: string;
  skill_path: string;
  runner: EvalRunnerName;
  timestamp: string;
  runs_per_configuration: number;
  compare_ref?: string;
  compare_skills?: string[];
  /** Status of the `without_skill` runs only. */
  baseline_status: BaselineStatus;
  /**
   * True when `with_skill` or `old_skill` runs may have loaded another copy of
   * the skill (such as a personal Claude skill) instead of the staged one.
   */
  with_skill_contaminated: boolean;
  warnings: string[];
}

export interface BenchmarkRunSummary {
  with_skill: VariantAggregate;
  without_skill?: VariantAggregate;
  old_skill?: VariantAggregate;
  compare_skills?: Record<string, VariantAggregate>;
  delta?: DeltaSummary;
  old_skill_delta?: DeltaSummary;
  compare_deltas?: Record<string, DeltaSummary>;
}

export interface BenchmarkSummary {
  schema_version: typeof EVAL_SCHEMA_VERSION;
  metadata: BenchmarkMetadata;
  run_summary: BenchmarkRunSummary;
  cases: CaseBenchmarkSummary[];
  non_discriminating_assertions: string[];
  assertion_analysis: AssertionAnalysis;
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

interface SummarizeCaseParams {
  evalCase: EvalCase;
  runs: readonly EvalRunRecord[];
  allVariants: readonly EvalVariant[];
  compareSkillNames: readonly string[];
}

function summarizeCase({
  evalCase,
  runs,
  allVariants,
  compareSkillNames,
}: SummarizeCaseParams): CaseBenchmarkSummary {
  const caseRuns = runs.filter((run) => run.case_id === evalCase.id);
  const variants: Partial<Record<EvalVariant, VariantAggregate>> = {};
  for (const variant of allVariants) {
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
    assertions: aggregateCaseAssertions({
      evalCase,
      caseRuns,
      compareSkillNames,
    }),
    runs: caseRuns,
  };
}

function buildRunSummary(
  runs: readonly EvalRunRecord[],
  compareSkillNames: readonly string[],
): BenchmarkRunSummary {
  const withRuns = runs.filter((run) => run.variant === 'with_skill');
  const withoutRuns = runs.filter((run) => run.variant === 'without_skill');
  const oldRuns = runs.filter((run) => run.variant === 'old_skill');

  const withAggregate = aggregateVariantRuns(withRuns);
  const withoutAggregate =
    withoutRuns.length > 0 ? aggregateVariantRuns(withoutRuns) : undefined;
  const oldAggregate =
    oldRuns.length > 0 ? aggregateVariantRuns(oldRuns) : undefined;

  const compareAggregates: Record<string, VariantAggregate> = {};
  const compareDeltas: Record<string, DeltaSummary> = {};
  for (const name of compareSkillNames) {
    const cRuns = runs.filter(
      (run) => run.variant === compareSkillVariant(name),
    );
    if (cRuns.length > 0) {
      const agg = aggregateVariantRuns(cRuns);
      compareAggregates[name] = agg;
      compareDeltas[name] = computeVariantDelta({
        primary: withAggregate,
        reference: agg,
      });
    }
  }

  return {
    with_skill: withAggregate,
    ...(withoutAggregate ? { without_skill: withoutAggregate } : {}),
    ...(oldAggregate ? { old_skill: oldAggregate } : {}),
    ...(Object.keys(compareAggregates).length > 0
      ? { compare_skills: compareAggregates }
      : {}),
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
    ...(Object.keys(compareDeltas).length > 0
      ? { compare_deltas: compareDeltas }
      : {}),
  };
}

export interface AggregateBenchmarkParams {
  skillName: string;
  skillPath: string;
  runner: EvalRunnerName;
  runsPerConfig: number;
  cases: readonly EvalCase[];
  runs: readonly EvalRunRecord[];
  baselineEnabled: boolean;
  /** From `without_skill` workspaces only (`PreparedWorkspace.possiblyContaminated`). */
  possiblyContaminated?: boolean;
  /** From `with_skill`/`old_skill` workspaces (`PreparedWorkspace.skillShadowed`). */
  withSkillContaminated?: boolean;
  compareRef?: string;
  compareSkills?: readonly string[];
  warnings?: readonly string[];
  timestamp?: string;
}

/**
 * Aggregates per-run grading and timing records across `with_skill`,
 * `without_skill`, `old_skill`, and `compare:<name>` variants into a
 * `BenchmarkSummary`, computing mean/stddev statistics, variant deltas,
 * per-assertion classifications, and contamination metadata.
 */
export function aggregateBenchmark({
  skillName,
  skillPath,
  runner,
  runsPerConfig,
  cases,
  runs,
  baselineEnabled,
  possiblyContaminated = false,
  withSkillContaminated = false,
  compareRef,
  compareSkills,
  warnings = [],
  timestamp = new Date().toISOString(),
}: AggregateBenchmarkParams): BenchmarkSummary {
  const discoveredCompareNames = [
    ...new Set(
      runs.flatMap((run) => {
        const name = parseCompareSkillVariant(run.variant);
        return name ? [name] : [];
      }),
    ),
  ];
  const compareSkillNames =
    compareSkills && compareSkills.length > 0
      ? compareSkills
      : discoveredCompareNames;
  const allVariants: EvalVariant[] = [
    'with_skill',
    'without_skill',
    'old_skill',
    ...compareSkillNames.map((name) => compareSkillVariant(name)),
  ];

  const caseSummaries = cases.map((evalCase) =>
    summarizeCase({ evalCase, runs, allVariants, compareSkillNames }),
  );
  const { nonDiscriminating, analysis } = buildAssertionAnalysis(
    caseSummaries,
    compareSkillNames,
  );
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
      ...(compareSkillNames.length > 0
        ? { compare_skills: [...compareSkillNames] }
        : {}),
      baseline_status: baselineStatus,
      with_skill_contaminated: withSkillContaminated,
      warnings: [...warnings],
    },
    run_summary: buildRunSummary(runs, compareSkillNames),
    cases: caseSummaries,
    non_discriminating_assertions: nonDiscriminating,
    assertion_analysis: analysis,
  };
}
