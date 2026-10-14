import { EVAL_SCHEMA_VERSION } from './artifacts.ts';
import type { TriggerQuery, TriggerSplit } from './cases.ts';
import type { EvalRunnerName } from './workspace.ts';

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
    /** True when another copy of the skill may be loaded instead of the staged one. */
    possibly_contaminated: boolean;
    warnings: string[];
  };
  metrics: TriggerMetrics;
  queries: TriggerQueryAggregate[];
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
  possiblyContaminated?: boolean;
  warnings?: readonly string[];
  timestamp?: string;
}

interface RatioParams {
  numerator: number;
  denominator: number;
}

function ratio({ numerator, denominator }: RatioParams): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Aggregates per-query trigger runs into confusion-matrix counts (`TP`, `FP`,
 * `TN`, `FN`) and classification metrics (`recall`, `precision`, `specificity`,
 * `false_positive_rate`, `accuracy`). Queries whose runs all errored are
 * excluded from metric denominators and counted in `errored_queries`.
 */
export function aggregateTriggerRuns({
  skillName,
  skillPath,
  runner,
  split,
  runsPerQuery,
  threshold,
  queries,
  results,
  possiblyContaminated = false,
  warnings = [],
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
      possibly_contaminated: possiblyContaminated,
      warnings: [...warnings],
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
