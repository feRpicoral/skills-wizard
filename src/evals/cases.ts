import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, normalize, posix } from 'node:path';

import { z } from 'zod';

import { EvalError } from '../errors.ts';
import { lstatIfExists, readTextIfExists } from '../install/fs.ts';
import { isSkillName } from '../skills/validate.ts';

function isSafeRelativePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isAbsolute(trimmed) || trimmed.startsWith('\\')) {
    return false;
  }
  const normalized = posix.normalize(trimmed.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return false;
  }
  return true;
}

// Case ids become directory names (`eval-<id>`), so keep them portable.
const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeCaseId(value: string): boolean {
  return SAFE_CASE_ID.test(value);
}

const safePathSchema = z
  .string()
  .transform((val) => val.trim())
  .refine(isSafeRelativePath, 'must be a safe relative path');

const fileExistsAssertionSchema = z.strictObject({
  type: z.literal('file_exists'),
  path: safePathSchema,
});

const fileAbsentAssertionSchema = z.strictObject({
  type: z.literal('file_absent'),
  path: safePathSchema,
});

const jsonValidAssertionSchema = z.strictObject({
  type: z.literal('json_valid'),
  path: safePathSchema,
});

const regexAssertionSchema = z
  .strictObject({
    type: z.literal('regex'),
    path: safePathSchema,
    pattern: z.string().min(1),
    flags: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    try {
      new RegExp(val.pattern, val.flags);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

const commandAssertionSchema = z.strictObject({
  type: z.literal('command'),
  run: z
    .string()
    .transform((val) => val.trim())
    .refine((val) => val.length > 0, 'must be a non-empty command'),
  expect: z.number().int().default(0),
});

const scriptedAssertionSchema = z.discriminatedUnion('type', [
  fileExistsAssertionSchema,
  fileAbsentAssertionSchema,
  jsonValidAssertionSchema,
  regexAssertionSchema,
  commandAssertionSchema,
]);

const evalAssertionSchema = z.union([
  z
    .string()
    .transform((val) => val.trim())
    .refine((val) => val.length > 0, 'must be a non-empty string'),
  scriptedAssertionSchema,
]);

const evalFileEntrySchema = safePathSchema
  .transform((val) => posix.normalize(val.replaceAll('\\', '/')))
  .refine(
    (val) => val.startsWith('evals/files/') && val !== 'evals/files',
    'must reside under "evals/files/"',
  );

const evalCaseSchema = z
  .strictObject({
    id: z
      .union([z.string(), z.number()])
      .transform((val) => String(val).trim())
      .refine(
        isSafeCaseId,
        'must start with a letter or digit and contain only letters, digits, ".", "_" or "-"',
      ),
    prompt: z
      .string()
      .transform((val) => val.trim())
      .refine((val) => val.length > 0, 'must be a non-empty string'),
    expected_output: z
      .string()
      .transform((val) => val.trim())
      .refine((val) => val.length > 0, 'must be a non-empty string'),
    files: z.array(evalFileEntrySchema).default([]),
    assertions: z.array(evalAssertionSchema).optional(),
    expectations: z.array(evalAssertionSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.assertions !== undefined && val.expectations !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'cannot define both "assertions" and "expectations"',
      });
      return;
    }
    if ((val.assertions ?? val.expectations ?? []).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'must define at least one assertion',
      });
    }
  })
  .transform(({ assertions, expectations, ...rest }) => ({
    ...rest,
    assertions: assertions ?? expectations ?? [],
  }));

const evalSuiteSchema = z.strictObject({
  skill_name: z.string().refine(isSkillName, 'must be a valid skill name'),
  evals: z.array(evalCaseSchema).min(1),
});

const triggerQuerySchema = z.strictObject({
  query: z
    .string()
    .transform((val) => val.trim())
    .refine((val) => val.length > 0, 'must be a non-empty string'),
  should_trigger: z.boolean(),
});

const triggerQueriesSchema = z.array(triggerQuerySchema).min(1);

export type ScriptedAssertion = z.infer<typeof scriptedAssertionSchema>;

export type EvalAssertion = z.infer<typeof evalAssertionSchema>;

export type EvalCase = z.infer<typeof evalCaseSchema>;

export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export type TriggerQuery = z.infer<typeof triggerQuerySchema>;

export type TriggerSplit = 'train' | 'validation' | 'all';

export interface TriggerQuerySplit {
  train: TriggerQuery[];
  validation: TriggerQuery[];
  /** Splits where a class has fewer than two queries. */
  warnings: string[];
}

export interface ParseEvalSuiteParams {
  raw: unknown;
  expectedSkillName?: string;
  sourcePath?: string;
}

export function parseEvalSuite({
  raw,
  expectedSkillName,
  sourcePath = 'evals/evals.json',
}: ParseEvalSuiteParams): EvalSuite {
  const result = evalSuiteSchema.safeParse(raw);
  if (!result.success) {
    throw new EvalError(`${sourcePath}: ${z.prettifyError(result.error)}`);
  }
  const suite = result.data;
  if (expectedSkillName && suite.skill_name !== expectedSkillName) {
    throw new EvalError(
      `${sourcePath}: skill_name "${suite.skill_name}" does not match skill directory "${expectedSkillName}"`,
    );
  }

  // Compared case-insensitively: on case-insensitive file systems `eval-A`
  // and `eval-a` would share one run directory.
  const seenIds = new Map<string, string>();
  for (const evalCase of suite.evals) {
    const key = evalCase.id.toLowerCase();
    const previous = seenIds.get(key);
    if (previous !== undefined) {
      const detail =
        previous === evalCase.id ? '' : ` (conflicts with "${previous}")`;
      throw new EvalError(
        `${sourcePath}: duplicate eval case id "${evalCase.id}"${detail}`,
      );
    }
    seenIds.set(key, evalCase.id);
  }

  return suite;
}

export async function loadEvalSuite(skillDir: string): Promise<EvalSuite> {
  const evalsPath = join(skillDir, 'evals', 'evals.json');
  const content = await readTextIfExists(evalsPath);
  if (content === null) {
    throw new EvalError(`Missing eval suite at ${evalsPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new EvalError(`Invalid JSON in ${evalsPath}`, { cause: error });
  }

  const suite = parseEvalSuite({
    raw,
    expectedSkillName: basename(normalize(skillDir)),
    sourcePath: evalsPath,
  });

  for (const evalCase of suite.evals) {
    for (const fileEntry of evalCase.files) {
      const fullPath = join(skillDir, fileEntry);
      const info = await lstatIfExists(fullPath);
      if (info === null) {
        throw new EvalError(
          `Eval case "${evalCase.id}" references missing file "${fileEntry}"`,
        );
      }
      if (!info.isFile()) {
        throw new EvalError(
          `Eval case "${evalCase.id}" file "${fileEntry}" is not a regular file`,
        );
      }
    }
  }

  return suite;
}

export function parseTriggerQueries(
  raw: unknown,
  sourcePath = 'evals/trigger_queries.json',
): TriggerQuery[] {
  const result = triggerQueriesSchema.safeParse(raw);
  if (!result.success) {
    throw new EvalError(`${sourcePath}: ${z.prettifyError(result.error)}`);
  }

  const seenQueries = new Set<string>();
  for (const item of result.data) {
    if (seenQueries.has(item.query)) {
      throw new EvalError(
        `${sourcePath}: duplicate trigger query "${item.query}"`,
      );
    }
    seenQueries.add(item.query);
  }

  return result.data;
}

export async function loadTriggerQueries(
  skillDir: string,
): Promise<TriggerQuery[]> {
  const queriesPath = join(skillDir, 'evals', 'trigger_queries.json');
  const content = await readTextIfExists(queriesPath);
  if (content === null) {
    throw new EvalError(`Missing trigger queries at ${queriesPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new EvalError(`Invalid JSON in ${queriesPath}`, { cause: error });
  }

  return parseTriggerQueries(raw, queriesPath);
}

const TRAIN_PERCENT = 60;
const MIN_QUERIES_PER_CLASS = 2;

// Each query lands in a split by its own hash, so adding or removing other
// queries never moves it between train and validation.
function isTrainQuery(query: string): boolean {
  const digest = createHash('sha256').update(query).digest('hex');
  return Number.parseInt(digest.slice(0, 8), 16) % 100 < TRAIN_PERCENT;
}

function splitBucket(
  bucket: readonly TriggerQuery[],
): Omit<TriggerQuerySplit, 'warnings'> {
  return {
    train: bucket.filter((item) => isTrainQuery(item.query)),
    validation: bucket.filter((item) => !isTrainQuery(item.query)),
  };
}

interface SplitWarningParams {
  split: 'train' | 'validation';
  label: string;
  count: number;
}

function splitWarning({
  split,
  label,
  count,
}: SplitWarningParams): string | null {
  if (count >= MIN_QUERIES_PER_CLASS) return null;
  return `The ${split} split has ${count} ${label} trigger ${count === 1 ? 'query' : 'queries'}; add more queries so each split has at least ${MIN_QUERIES_PER_CLASS}.`;
}

export function splitTriggerQueries(
  queries: readonly TriggerQuery[],
): TriggerQuerySplit {
  const positive = queries.filter((item) => item.should_trigger);
  const negative = queries.filter((item) => !item.should_trigger);
  const posSplit = splitBucket(positive);
  const negSplit = splitBucket(negative);
  const warnings = [
    splitWarning({
      split: 'train',
      label: 'should-trigger',
      count: posSplit.train.length,
    }),
    splitWarning({
      split: 'train',
      label: 'should-not-trigger',
      count: negSplit.train.length,
    }),
    splitWarning({
      split: 'validation',
      label: 'should-trigger',
      count: posSplit.validation.length,
    }),
    splitWarning({
      split: 'validation',
      label: 'should-not-trigger',
      count: negSplit.validation.length,
    }),
  ].filter((item): item is string => item !== null);

  return {
    train: [...posSplit.train, ...negSplit.train],
    validation: [...posSplit.validation, ...negSplit.validation],
    warnings,
  };
}

export function selectTriggerQueries(
  queries: readonly TriggerQuery[],
  split: TriggerSplit,
): TriggerQuery[] {
  if (split === 'all') {
    return [...queries];
  }
  const partitioned = splitTriggerQueries(queries);
  return split === 'train' ? partitioned.train : partitioned.validation;
}
