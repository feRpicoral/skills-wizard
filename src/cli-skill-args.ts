import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SkillCommandOptions } from './commands/skill.ts';
import { UsageError } from './errors.ts';
import { isSkillName } from './skills/validate.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

const DEFAULT_STRING_OPTIONS = new Set<string>([
  '--project',
  '--tools',
  '--blocks',
  '--skills',
  '--skill-mode',
  '--preset',
  '--style',
  '--template',
  '--runner',
  '--binary',
  '--runs',
  '--compare',
  '--case',
  '--cases',
  '--parallel',
  '--timeout',
  '--split',
  '--threshold',
  '--var',
]);

// `skill eval <name>` has exactly three positionals: skill, eval and <name>.
const SKILL_EVAL_POSITIONALS = 3;

export interface NormalizedArgv {
  args: string[];
  baselineRef?: string;
}

function isBaselineKeyword(value: string): boolean {
  return value === 'none' || value === 'false' || value === 'true';
}

function isBaselineRefCandidate(value: string | undefined): value is string {
  return (
    value !== undefined && !value.startsWith('-') && !isBaselineKeyword(value)
  );
}

function isExistingSkillTarget(candidate: string): boolean {
  const cwd = process.cwd();
  return (
    (isSkillName(candidate) &&
      (existsSync(join(cwd, 'skills', candidate, 'SKILL.md')) ||
        existsSync(join(REPO_ROOT, 'skills', candidate, 'SKILL.md')))) ||
    existsSync(join(resolve(cwd, candidate), 'SKILL.md'))
  );
}

function hasLaterSkillTarget(
  argv: readonly string[],
  startIndex: number,
  stringOptions: ReadonlySet<string>,
): boolean {
  for (let index = startIndex; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') {
      return argv.slice(index + 1).some(isExistingSkillTarget);
    }
    if (stringOptions.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-') && isExistingSkillTarget(token)) {
      return true;
    }
  }
  return false;
}

function isBaselineRefToken(
  argv: readonly string[],
  index: number,
  positionalsSeen: number,
  stringOptions: ReadonlySet<string>,
): boolean {
  const next = argv[index + 1];
  if (!isBaselineRefCandidate(next)) return false;
  if (
    positionalsSeen < SKILL_EVAL_POSITIONALS &&
    isExistingSkillTarget(next) &&
    !hasLaterSkillTarget(argv, index + 2, stringOptions)
  ) {
    return false;
  }
  return true;
}

// Counts positionals without the tokens that may be a `--baseline <ref>`
// value, so `--baseline <ref>` is accepted in any position. The token after
// `--baseline` is a ref only when the command already has all of its
// positionals without it (`skill eval --baseline main my-skill`); otherwise
// it is the skill name (`skill eval --baseline my-skill`).
function countPositionals(
  argv: readonly string[],
  stringOptions: ReadonlySet<string>,
): number {
  let count = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') return count + argv.length - index - 1;
    if (
      token === '--baseline' &&
      isBaselineRefToken(argv, index, count, stringOptions)
    ) {
      index += 1;
      continue;
    }
    if (stringOptions.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) count += 1;
  }
  return count;
}

function baselineRefValue(ref: string, previous: string | undefined): string {
  if (previous !== undefined) {
    throw new UsageError('--baseline <ref> was given more than once');
  }
  if (ref.startsWith('-')) {
    throw new UsageError(
      `--baseline ref must not start with "-", got "${ref}"`,
    );
  }
  return ref;
}

/**
 * Rewrites `--baseline` arguments before `parseArgs` runs so `--baseline` can
 * act as both a boolean flag and a `--baseline <ref>` option.
 *
 * - `--baseline` / `--baseline=true` / `--baseline true` -> `--baseline`
 * - `--baseline=false` / `--baseline=none` / `--baseline none` -> `--no-baseline`
 * - `--baseline=<ref>` or `--baseline <ref>` (when all 3 `skill eval <name>`
 *   positionals are otherwise present) -> strips the token from `args` and
 *   returns `baselineRef: <ref>`.
 */
export function normalizeBaselineArgv(
  argv: readonly string[],
  stringOptions: ReadonlySet<string> = DEFAULT_STRING_OPTIONS,
): NormalizedArgv {
  const args: string[] = [];
  let baselineRef: string | undefined;
  let positionalsSeen = 0;
  const isSkillEval = argv[0] === 'skill' && argv[1] === 'eval';
  const refsAllowed =
    isSkillEval &&
    countPositionals(argv, stringOptions) === SKILL_EVAL_POSITIONALS;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') {
      args.push(...argv.slice(index));
      break;
    }
    if (token.startsWith('--baseline=')) {
      const val = token.slice('--baseline='.length).trim();
      if (val === '' || val === 'true') {
        args.push('--baseline');
      } else if (val === 'false' || val === 'none') {
        args.push('--no-baseline');
      } else {
        baselineRef = baselineRefValue(val, baselineRef);
      }
      continue;
    }
    if (token === '--baseline') {
      const next = argv[index + 1];
      if (next === 'none' || next === 'false') {
        args.push('--no-baseline');
        index += 1;
      } else if (next === 'true') {
        args.push('--baseline');
        index += 1;
      } else if (
        refsAllowed &&
        next !== undefined &&
        isBaselineRefToken(argv, index, positionalsSeen, stringOptions)
      ) {
        baselineRef = baselineRefValue(next, baselineRef);
        index += 1;
      } else {
        args.push('--baseline');
      }
      continue;
    }
    if (stringOptions.has(token)) {
      args.push(token);
      const next = argv[index + 1];
      if (next !== undefined) {
        args.push(next);
        index += 1;
      }
      continue;
    }
    if (!token.startsWith('-')) positionalsSeen += 1;
    args.push(token);
  }

  return { args, ...(baselineRef !== undefined ? { baselineRef } : {}) };
}

export function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

interface ParseFlagParams {
  value: string | undefined;
  flagName: string;
}

// Number() accepts '', ' 1', '0x1' and '1e1'; flags only take plain decimals.
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const DECIMAL = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/;

export function parsePositiveInt({
  value,
  flagName,
}: ParseFlagParams): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(parsed)) {
    throw new UsageError(
      `--${flagName} must be a positive integer, got "${value}"`,
    );
  }
  return parsed;
}

export function parseFloatFlag({
  value,
  flagName,
}: ParseFlagParams): number | undefined {
  if (value === undefined) return undefined;
  if (!DECIMAL.test(value)) {
    throw new UsageError(`--${flagName} must be a number, got "${value}"`);
  }
  return Number(value);
}

export interface ParsedSkillValues {
  catalog?: boolean | undefined;
  template?: string | undefined;
  'with-evals'?: boolean | undefined;
  runner?: string | undefined;
  binary?: string | undefined;
  runs?: string | undefined;
  baseline?: boolean | undefined;
  compare?: string | undefined;
  case?: string | undefined;
  cases?: string | undefined;
  parallel?: string | undefined;
  timeout?: string | undefined;
  sandbox?: boolean | undefined;
  'keep-workdirs'?: boolean | undefined;
  split?: string | undefined;
  threshold?: string | undefined;
}

interface BuildSkillCommandOptionsParams {
  values: ParsedSkillValues;
  positionals: readonly string[];
  baselineRef: string | undefined;
}

/**
 * Validates and converts parsed CLI option values and positional arguments into
 * {@link SkillCommandOptions} for `agents-config skill` subcommands.
 */
export function buildSkillCommandOptions({
  values,
  positionals,
  baselineRef,
}: BuildSkillCommandOptionsParams): SkillCommandOptions {
  const runs = parsePositiveInt({ value: values.runs, flagName: 'runs' });
  const parallel = parsePositiveInt({
    value: values.parallel,
    flagName: 'parallel',
  });
  const timeout = parsePositiveInt({
    value: values.timeout,
    flagName: 'timeout',
  });
  const threshold = parseFloatFlag({
    value: values.threshold,
    flagName: 'threshold',
  });
  const cases = parseList(values.cases);
  if (baselineRef !== undefined && values.compare !== undefined) {
    throw new UsageError(
      'Use either --baseline <ref> or --compare <ref>, not both.',
    );
  }
  if (baselineRef !== undefined && values.baseline !== undefined) {
    throw new UsageError(
      'Use one form of --baseline: --baseline <ref>, --baseline none or --no-baseline.',
    );
  }
  if (values.compare?.startsWith('-')) {
    throw new UsageError(
      `--compare ref must not start with "-", got "${values.compare}"`,
    );
  }
  // `--baseline <ref>` replaces the without_skill baseline with the
  // old_skill snapshot from <ref>.
  const baseline = baselineRef !== undefined ? false : values.baseline;
  const compare = baselineRef ?? values.compare;
  return {
    subcommand: positionals[1],
    paths: positionals.slice(2),
    catalog: values.catalog ?? false,
    ...(values.template !== undefined ? { template: values.template } : {}),
    ...(values['with-evals'] !== undefined
      ? { withEvals: values['with-evals'] }
      : {}),
    ...(values.runner !== undefined ? { runner: values.runner } : {}),
    ...(values.binary !== undefined ? { binary: values.binary } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(compare !== undefined ? { compare } : {}),
    ...(values.case !== undefined ? { caseId: values.case } : {}),
    ...(cases !== undefined ? { cases } : {}),
    ...(parallel !== undefined ? { parallel } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(values.sandbox !== undefined ? { sandbox: values.sandbox } : {}),
    ...(values['keep-workdirs'] !== undefined
      ? { keepWorkdirs: values['keep-workdirs'] }
      : {}),
    ...(values.split !== undefined ? { split: values.split } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
  };
}
