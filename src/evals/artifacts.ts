import { join } from 'node:path';

import { z } from 'zod';

import { EvalError } from '../errors.ts';
import type { BenchmarkSummary, TriggerBenchmarkSummary } from './aggregate.ts';
import { readEvalJsonFile } from './cases.ts';
import { EVAL_RUNNER_NAMES } from './workspace.ts';

/** Version of the `benchmark.json` and `triggers.json` formats. */
export const EVAL_SCHEMA_VERSION = 1;

const VARIANTS = ['with_skill', 'without_skill', 'old_skill'] as const;
const CLASSIFICATIONS = [
  'differentiating',
  'non-discriminating',
  'regressing',
  'failing',
  'flaky',
  'no-baseline',
] as const;
const ASSERTION_KINDS = [
  'string',
  'file_exists',
  'file_absent',
  'regex',
  'json_valid',
  'command',
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
        kind: z.enum(ASSERTION_KINDS),
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
    duration_ms: z.number(),
    total_duration_seconds: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
    triggered: z.boolean(),
    exit_code: z.number(),
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
    runner: z.enum(EVAL_RUNNER_NAMES),
    timestamp: z.string(),
    runs_per_configuration: z.number().int(),
    compare_ref: z.string().optional(),
    baseline_status: z.enum(['clean', 'possibly contaminated', 'skipped']),
    with_skill_contaminated: z.boolean().default(false),
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
    runner: z.enum(EVAL_RUNNER_NAMES),
    split: z.enum(['train', 'validation', 'all']),
    runs_per_query: z.number().int(),
    threshold: z.number(),
    timestamp: z.string(),
    possibly_contaminated: z.boolean().default(false),
    warnings: z.array(z.string()).default([]),
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

export interface ParseSummaryParams {
  raw: unknown;
  sourcePath: string;
}

/** Validates a parsed `benchmark.json`, throwing an `EvalError` if invalid. */
export function parseBenchmarkSummary({
  raw,
  sourcePath,
}: ParseSummaryParams): BenchmarkSummary {
  const result = benchmarkSummarySchema.safeParse(raw);
  if (!result.success) {
    throw new EvalError(
      `Invalid benchmark in ${sourcePath}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/** Validates a parsed `triggers.json`, throwing an `EvalError` if invalid. */
export function parseTriggerBenchmarkSummary({
  raw,
  sourcePath,
}: ParseSummaryParams): TriggerBenchmarkSummary {
  const result = triggerBenchmarkSummarySchema.safeParse(raw);
  if (!result.success) {
    throw new EvalError(
      `Invalid trigger summary in ${sourcePath}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export async function loadBenchmarkFromIteration(
  iterationDir: string,
): Promise<BenchmarkSummary> {
  const benchmarkPath = join(iterationDir, 'benchmark.json');
  return parseBenchmarkSummary({
    raw: await readEvalJsonFile({
      path: benchmarkPath,
      missingMessage: `Missing benchmark.json in ${iterationDir}`,
    }),
    sourcePath: benchmarkPath,
  });
}

export async function loadTriggerSummary(
  outputDir: string,
): Promise<TriggerBenchmarkSummary> {
  const summaryPath = join(outputDir, 'triggers.json');
  return parseTriggerBenchmarkSummary({
    raw: await readEvalJsonFile({
      path: summaryPath,
      missingMessage: `Missing triggers.json in ${outputDir}`,
    }),
    sourcePath: summaryPath,
  });
}
