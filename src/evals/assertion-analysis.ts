import type { EvalCase } from './cases.ts';
import {
  formatAssertionLabel,
  type GradingReport,
  type TimingReport,
} from './grade.ts';
import { compareSkillVariant, type EvalVariant } from './workspace.ts';

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
  compare_pass_rates?: Record<string, number>;
  /**
   * Compared with `without_skill`, or with `old_skill` when the eval ran no
   * baseline; `no-baseline` when there is neither.
   */
  classification: AssertionClassification;
  /** Compared with `old_skill`; present only with `--compare`. */
  old_skill_classification?: AssertionClassification;
  /** Compared with each competing skill; present only with `--compare <skill>`. */
  compare_classifications?: Record<string, AssertionClassification>;
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
  /** Assertions that pass less often with the skill than with each compared skill. */
  regressing_vs_compare?: Record<string, string[]>;
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

export interface AggregateCaseAssertionsParams {
  evalCase: EvalCase;
  caseRuns: readonly EvalRunRecord[];
  compareSkillNames: readonly string[];
}

export function aggregateCaseAssertions({
  evalCase,
  caseRuns,
  compareSkillNames,
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
    const comparePassRates: Record<string, number> = {};
    const compareClassifications: Record<string, AssertionClassification> = {};
    for (const name of compareSkillNames) {
      const rate = rateFor(
        caseRuns.filter((run) => run.variant === compareSkillVariant(name)),
      );
      if (rate !== undefined) {
        comparePassRates[name] = rate;
        compareClassifications[name] = classifyAssertion({
          withSkillRate: withRate,
          referenceRate: rate,
        });
      }
    }
    const firstCompareRate =
      compareSkillNames[0] !== undefined
        ? comparePassRates[compareSkillNames[0]]
        : undefined;

    return {
      text: label,
      kind,
      with_skill_pass_rate: withRate,
      ...(withoutRate !== undefined ? { baseline_pass_rate: withoutRate } : {}),
      ...(oldRate !== undefined ? { old_skill_pass_rate: oldRate } : {}),
      ...(Object.keys(comparePassRates).length > 0
        ? { compare_pass_rates: comparePassRates }
        : {}),
      classification: classifyAssertion({
        withSkillRate: withRate,
        referenceRate: withoutRate ?? oldRate ?? firstCompareRate,
      }),
      ...(oldRate !== undefined
        ? {
            old_skill_classification: classifyAssertion({
              withSkillRate: withRate,
              referenceRate: oldRate,
            }),
          }
        : {}),
      ...(Object.keys(compareClassifications).length > 0
        ? { compare_classifications: compareClassifications }
        : {}),
    };
  });
}

export function buildAssertionAnalysis(
  caseSummaries: readonly CaseBenchmarkSummary[],
  compareSkillNames: readonly string[],
): {
  nonDiscriminating: string[];
  analysis: AssertionAnalysis;
} {
  const nonDiscriminating: string[] = [];
  const passOnlyWithSkill: string[] = [];
  const passInBoth: string[] = [];
  const failInBoth: string[] = [];
  const flaky: string[] = [];
  const regressing: string[] = [];
  const regressingVsOld: string[] = [];
  const regressingVsCompare: Record<string, string[]> = Object.fromEntries(
    compareSkillNames.map((name) => [name, []]),
  );

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
      for (const name of compareSkillNames) {
        if (assertion.compare_classifications?.[name] === 'regressing') {
          regressingVsCompare[name]?.push(entry);
        }
      }
    }
  }

  return {
    nonDiscriminating,
    analysis: {
      pass_only_with_skill: passOnlyWithSkill,
      pass_in_both: passInBoth,
      fail_in_both: failInBoth,
      flaky,
      regressing,
      regressing_vs_old: regressingVsOld,
      ...(compareSkillNames.length > 0
        ? { regressing_vs_compare: regressingVsCompare }
        : {}),
    },
  };
}
