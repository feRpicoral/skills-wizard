import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, normalize, posix } from 'node:path';

import { EvalError } from '../errors.ts';
import { lstatIfExists, readTextIfExists } from '../install/fs.ts';
import { isSkillName } from '../skills/validate.ts';

export type ScriptedAssertion =
  | { type: 'file_exists'; path: string }
  | { type: 'file_absent'; path: string }
  | { type: 'regex'; path: string; pattern: string; flags?: string }
  | { type: 'json_valid'; path: string }
  | { type: 'command'; run: string; expect: number };

export type EvalAssertion = string | ScriptedAssertion;

export interface EvalCase {
  id: string;
  prompt: string;
  expected_output: string;
  files: string[];
  assertions: EvalAssertion[];
}

export interface EvalSuite {
  skill_name: string;
  evals: EvalCase[];
}

export interface TriggerQuery {
  query: string;
  should_trigger: boolean;
}

export type TriggerSplit = 'train' | 'validation' | 'all';

export interface TriggerQuerySplit {
  train: TriggerQuery[];
  validation: TriggerQuery[];
}

export interface ParseEvalSuiteParams {
  raw: unknown;
  expectedSkillName?: string;
  sourcePath?: string;
}

const EVAL_CASE_KEYS = new Set([
  'id',
  'prompt',
  'expected_output',
  'files',
  'assertions',
  'expectations',
]);

const TRIGGER_QUERY_KEYS = new Set(['query', 'should_trigger']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function isSafeCaseId(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new EvalError(`${label} has unknown field "${key}"`);
    }
  }
}

function parseScriptedAssertion(
  record: Record<string, unknown>,
  label: string,
): ScriptedAssertion {
  const type = record.type;
  if (
    type === 'file_exists' ||
    type === 'file_absent' ||
    type === 'json_valid'
  ) {
    assertOnlyKeys(record, new Set(['type', 'path']), label);
    if (typeof record.path !== 'string' || !isSafeRelativePath(record.path)) {
      throw new EvalError(`${label} (${type}) requires a safe relative "path"`);
    }
    return { type, path: record.path.trim() };
  }

  if (type === 'regex') {
    assertOnlyKeys(
      record,
      new Set(['type', 'path', 'pattern', 'flags']),
      label,
    );
    if (typeof record.path !== 'string' || !isSafeRelativePath(record.path)) {
      throw new EvalError(`${label} (regex) requires a safe relative "path"`);
    }
    if (typeof record.pattern !== 'string' || record.pattern.length === 0) {
      throw new EvalError(`${label} (regex) requires a non-empty "pattern"`);
    }
    let flags: string | undefined;
    if (record.flags !== undefined) {
      if (typeof record.flags !== 'string') {
        throw new EvalError(`${label} (regex) "flags" must be a string`);
      }
      flags = record.flags;
    }
    try {
      new RegExp(record.pattern, flags);
    } catch (error) {
      throw new EvalError(
        `${label} (regex) has invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return {
      type: 'regex',
      path: record.path.trim(),
      pattern: record.pattern,
      ...(flags !== undefined ? { flags } : {}),
    };
  }

  if (type === 'command') {
    assertOnlyKeys(record, new Set(['type', 'run', 'expect']), label);
    if (typeof record.run !== 'string' || !record.run.trim()) {
      throw new EvalError(`${label} (command) requires a non-empty "run"`);
    }
    let expectCode = 0;
    if (record.expect !== undefined) {
      if (
        typeof record.expect !== 'number' ||
        !Number.isInteger(record.expect)
      ) {
        throw new EvalError(
          `${label} (command) "expect" must be an integer exit code`,
        );
      }
      expectCode = record.expect;
    }
    return { type: 'command', run: record.run.trim(), expect: expectCode };
  }

  throw new EvalError(
    `${label} has unsupported assertion type "${String(type)}"`,
  );
}

function parseAssertion(raw: unknown, label: string): EvalAssertion {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new EvalError(`${label} cannot be an empty string`);
    }
    return trimmed;
  }
  if (isRecord(raw)) {
    return parseScriptedAssertion(raw, label);
  }
  throw new EvalError(
    `${label} must be a non-empty string or scripted assertion object`,
  );
}

function parseEvalCase(raw: unknown, index: number): EvalCase {
  const label = `evals[${index}]`;
  if (!isRecord(raw)) {
    throw new EvalError(`${label} must be an object`);
  }
  assertOnlyKeys(raw, EVAL_CASE_KEYS, label);

  const rawId = raw.id;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new EvalError(`${label}.id must be a string or number`);
  }
  const id = String(rawId).trim();
  if (!isSafeCaseId(id)) {
    throw new EvalError(`${label}.id "${id}" is not a valid case identifier`);
  }

  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
    throw new EvalError(`${label}.prompt must be a non-empty string`);
  }
  if (typeof raw.expected_output !== 'string' || !raw.expected_output.trim()) {
    throw new EvalError(`${label}.expected_output must be a non-empty string`);
  }

  const files: string[] = [];
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files)) {
      throw new EvalError(`${label}.files must be an array of paths`);
    }
    for (const [fileIndex, entry] of raw.files.entries()) {
      if (typeof entry !== 'string' || !isSafeRelativePath(entry)) {
        throw new EvalError(
          `${label}.files[${fileIndex}] must be a safe relative path`,
        );
      }
      const normalized = posix.normalize(entry.trim().replaceAll('\\', '/'));
      if (
        !normalized.startsWith('evals/files/') ||
        normalized === 'evals/files'
      ) {
        throw new EvalError(
          `${label}.files[${fileIndex}] must reside under "evals/files/", got "${entry}"`,
        );
      }
      files.push(normalized);
    }
  }

  if (raw.assertions !== undefined && raw.expectations !== undefined) {
    throw new EvalError(
      `${label} cannot define both "assertions" and "expectations"`,
    );
  }
  const rawAssertions = raw.assertions ?? raw.expectations ?? [];
  if (!Array.isArray(rawAssertions)) {
    throw new EvalError(`${label}.assertions must be an array`);
  }
  const assertions = rawAssertions.map((item, assertionIndex) =>
    parseAssertion(item, `${label}.assertions[${assertionIndex}]`),
  );

  return {
    id,
    prompt: raw.prompt.trim(),
    expected_output: raw.expected_output.trim(),
    files,
    assertions,
  };
}

export function parseEvalSuite({
  raw,
  expectedSkillName,
  sourcePath = 'evals/evals.json',
}: ParseEvalSuiteParams): EvalSuite {
  if (!isRecord(raw)) {
    throw new EvalError(`${sourcePath} must contain a JSON object`);
  }
  assertOnlyKeys(raw, new Set(['skill_name', 'evals']), sourcePath);

  if (typeof raw.skill_name !== 'string' || !isSkillName(raw.skill_name)) {
    throw new EvalError(
      `${sourcePath}: "skill_name" must be a valid skill name`,
    );
  }
  if (expectedSkillName && raw.skill_name !== expectedSkillName) {
    throw new EvalError(
      `${sourcePath}: skill_name "${raw.skill_name}" does not match skill directory "${expectedSkillName}"`,
    );
  }

  if (!Array.isArray(raw.evals) || raw.evals.length === 0) {
    throw new EvalError(`${sourcePath}: "evals" must be a non-empty array`);
  }

  const seenIds = new Set<string>();
  const evals = raw.evals.map((item, index) => {
    const parsed = parseEvalCase(item, index);
    if (seenIds.has(parsed.id)) {
      throw new EvalError(
        `${sourcePath}: duplicate eval case id "${parsed.id}"`,
      );
    }
    seenIds.add(parsed.id);
    return parsed;
  });

  return {
    skill_name: raw.skill_name,
    evals,
  };
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
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new EvalError(
      `${sourcePath} must be a non-empty JSON array of trigger queries`,
    );
  }

  const seenQueries = new Set<string>();
  return raw.map((item, index) => {
    const label = `${sourcePath}[${index}]`;
    if (!isRecord(item)) {
      throw new EvalError(`${label} must be an object`);
    }
    assertOnlyKeys(item, TRIGGER_QUERY_KEYS, label);
    if (typeof item.query !== 'string' || !item.query.trim()) {
      throw new EvalError(`${label}.query must be a non-empty string`);
    }
    if (typeof item.should_trigger !== 'boolean') {
      throw new EvalError(`${label}.should_trigger must be a boolean`);
    }
    const query = item.query.trim();
    if (seenQueries.has(query)) {
      throw new EvalError(`${sourcePath}: duplicate trigger query "${query}"`);
    }
    seenQueries.add(query);
    return {
      query,
      should_trigger: item.should_trigger,
    };
  });
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

function queryDigest(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

function splitBucket(bucket: readonly TriggerQuery[]): TriggerQuerySplit {
  const sorted = [...bucket].sort((left, right) => {
    const leftHash = queryDigest(left.query);
    const rightHash = queryDigest(right.query);
    if (leftHash !== rightHash) {
      return leftHash < rightHash ? -1 : 1;
    }
    return left.query.localeCompare(right.query);
  });
  const trainCount = Math.round(sorted.length * 0.6);
  return {
    train: sorted.slice(0, trainCount),
    validation: sorted.slice(trainCount),
  };
}

export function splitTriggerQueries(
  queries: readonly TriggerQuery[],
): TriggerQuerySplit {
  const positive = queries.filter((item) => item.should_trigger);
  const negative = queries.filter((item) => !item.should_trigger);
  const posSplit = splitBucket(positive);
  const negSplit = splitBucket(negative);

  return {
    train: [...posSplit.train, ...negSplit.train],
    validation: [...posSplit.validation, ...negSplit.validation],
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
