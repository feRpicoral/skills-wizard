import { parseArgs } from 'node:util';

import type { Scope } from './blocks/library.ts';
import type { SkillCommandOptions } from './commands/skill.ts';
import { UsageError } from './errors.ts';
import {
  isPresetChoice,
  isProjectStyle,
  PRESET_IDS,
  type PresetChoice,
  PROJECT_STYLES,
  type ProjectStyle,
} from './project/presets.ts';
import { SKILL_MODES, type SkillMode } from './skills/install.ts';
import { isToolId, type ToolId } from './tools/registry.ts';

export const OPTIONS = {
  global: { type: 'boolean' },
  project: { type: 'string' },
  tools: { type: 'string' },
  blocks: { type: 'string' },
  skills: { type: 'string' },
  'skill-mode': { type: 'string' },
  preset: { type: 'string' },
  style: { type: 'string' },
  catalog: { type: 'boolean' },
  template: { type: 'string' },
  'with-evals': { type: 'boolean' },
  runner: { type: 'string' },
  binary: { type: 'string' },
  runs: { type: 'string' },
  baseline: { type: 'boolean' },
  compare: { type: 'string' },
  case: { type: 'string' },
  cases: { type: 'string' },
  parallel: { type: 'string' },
  timeout: { type: 'string' },
  sandbox: { type: 'boolean' },
  'keep-workdirs': { type: 'boolean' },
  split: { type: 'string' },
  threshold: { type: 'string' },
  var: { type: 'string', multiple: true },
  'link-command': { type: 'boolean' },
  local: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

export type OptionName = keyof typeof OPTIONS;
export type ParsedValues = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS }>
>['values'];

const STRING_OPTIONS = new Set<string>(
  Object.entries(OPTIONS)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => `--${name}`),
);

export const COMMANDS = [
  'init',
  'sync',
  'update',
  'adopt',
  'doctor',
  'skill',
] as const;

export type Command = (typeof COMMANDS)[number];

const ALLOWED: Readonly<Record<Command, readonly OptionName[]>> = {
  init: [
    'global',
    'project',
    'tools',
    'blocks',
    'skills',
    'skill-mode',
    'preset',
    'style',
    'var',
    'link-command',
    'local',
    'yes',
    'dry-run',
  ],
  sync: ['global', 'project', 'yes', 'dry-run'],
  update: ['yes', 'dry-run'],
  adopt: ['skills', 'tools', 'yes', 'dry-run'],
  doctor: ['global', 'project'],
  skill: [
    'catalog',
    'template',
    'with-evals',
    'runner',
    'binary',
    'runs',
    'baseline',
    'compare',
    'case',
    'cases',
    'parallel',
    'timeout',
    'sandbox',
    'keep-workdirs',
    'split',
    'threshold',
  ],
};

const SKILL_SUBCOMMAND_OPTIONS: Readonly<
  Record<string, readonly OptionName[]>
> = {
  validate: ['catalog'],
  new: ['template', 'with-evals'],
  eval: [
    'runner',
    'binary',
    'runs',
    'baseline',
    'compare',
    'case',
    'cases',
    'parallel',
    'timeout',
    'sandbox',
    'keep-workdirs',
  ],
  triggers: [
    'runner',
    'binary',
    'runs',
    'split',
    'threshold',
    'parallel',
    'timeout',
    'sandbox',
    'keep-workdirs',
  ],
  report: [],
};

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

// Counts positionals without the tokens that may be a `--baseline <ref>`
// value, so `--baseline <ref>` is accepted in any position. The token after
// `--baseline` is a ref only when the command already has all of its
// positionals without it (`skill eval --baseline main my-skill`); otherwise
// it is the skill name (`skill eval --baseline my-skill`).
function countPositionals(argv: readonly string[]): number {
  let count = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') return count + argv.length - index - 1;
    if (token === '--baseline' && isBaselineRefCandidate(argv[index + 1])) {
      index += 1;
      continue;
    }
    if (STRING_OPTIONS.has(token)) {
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
export function normalizeBaselineArgv(argv: readonly string[]): NormalizedArgv {
  const args: string[] = [];
  let baselineRef: string | undefined;
  const isSkillEval = argv[0] === 'skill' && argv[1] === 'eval';
  const refsAllowed =
    isSkillEval && countPositionals(argv) === SKILL_EVAL_POSITIONALS;

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
      } else if (refsAllowed && isBaselineRefCandidate(next)) {
        baselineRef = baselineRefValue(next, baselineRef);
        index += 1;
      } else {
        args.push('--baseline');
      }
      continue;
    }
    if (STRING_OPTIONS.has(token)) {
      args.push(token);
      const next = argv[index + 1];
      if (next !== undefined) {
        args.push(next);
        index += 1;
      }
      continue;
    }
    args.push(token);
  }

  return { args, ...(baselineRef !== undefined ? { baselineRef } : {}) };
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function flags(names: readonly string[]): string {
  return names.map((name) => `--${name}`).join(', ');
}

export function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseTools(value: string | undefined): ToolId[] | undefined {
  const ids = parseList(value);
  if (!ids) return undefined;
  const unknown = ids.filter((id) => !isToolId(id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown tools: ${unknown.join(', ')}`);
  }
  return ids.filter(isToolId);
}

export function parseSkillMode(
  value: string | undefined,
): SkillMode | undefined {
  if (value === undefined) return undefined;
  const mode = SKILL_MODES.find((candidate) => candidate === value);
  if (!mode) {
    throw new UsageError(
      `--skill-mode must be one of ${SKILL_MODES.join(', ')}, got "${value}"`,
    );
  }
  return mode;
}

export function parsePreset(
  value: string | undefined,
): PresetChoice | undefined {
  if (value === undefined) return undefined;
  if (!isPresetChoice(value)) {
    throw new UsageError(
      `--preset must be one of ${PRESET_IDS.join(', ')}, none, got "${value}"`,
    );
  }
  return value;
}

export function parseProjectStyle(
  value: string | undefined,
): ProjectStyle | undefined {
  if (value === undefined) return undefined;
  if (value === 'strict') return 'self-contained';
  if (!isProjectStyle(value)) {
    throw new UsageError(
      `--style must be one of ${PROJECT_STYLES.join(', ')}, got "${value}"`,
    );
  }
  return value;
}

export function parseVariables(
  values: string[] | undefined,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const entry of values ?? []) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      throw new UsageError(`Expected --var name=value, got "${entry}"`);
    }
    variables[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return variables;
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

function rejectOptions(command: Command, provided: readonly string[]): void {
  const allowed: readonly string[] = ALLOWED[command];
  const extra = provided.filter((name) => !allowed.includes(name));
  if (extra.length > 0) {
    throw new UsageError(`${flags(extra)} does not apply to ${command}`);
  }
}

function rejectSkillOptions(
  subcommand: string | undefined,
  provided: readonly string[],
): void {
  if (
    subcommand === undefined ||
    !Object.hasOwn(SKILL_SUBCOMMAND_OPTIONS, subcommand)
  ) {
    return;
  }
  const allowed: readonly string[] = SKILL_SUBCOMMAND_OPTIONS[subcommand] ?? [];
  const extra = provided.filter((name) => !allowed.includes(name));
  if (extra.length > 0) {
    throw new UsageError(
      `${flags(extra)} does not apply to skill ${subcommand}`,
    );
  }
}

interface BuildSkillCommandOptionsParams {
  values: ParsedValues;
  positionals: readonly string[];
  baselineRef: string | undefined;
}

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

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'default' }
  | {
      kind: 'command';
      command: Command;
      positionals: string[];
      values: ParsedValues;
      baselineRef?: string;
      scope?: Scope;
      yes: boolean;
      dryRun: boolean;
      projectDir?: string;
    };

export function parseCommand(argv: string[]): ParsedCommand {
  let parsed;
  let baselineRef: string | undefined;
  try {
    const normalized = normalizeBaselineArgv(argv);
    baselineRef = normalized.baselineRef;
    parsed = parseArgs({
      args: normalized.args,
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };
  if (values.global && values.project !== undefined) {
    throw new UsageError('Use either --global or --project, not both.');
  }

  const command = positionals[0];
  if (command === undefined || command === 'help') {
    if (positionals.length > 1) {
      throw new UsageError(
        `Unexpected arguments: ${positionals.slice(1).join(' ')}`,
      );
    }
    if (command === undefined) {
      const provided = Object.keys(values);
      if (baselineRef !== undefined) provided.push('baseline');
      if (provided.length > 0) {
        throw new UsageError(
          `${flags(provided)} must follow a command such as init`,
        );
      }
      return { kind: 'default' };
    }
    return { kind: 'help' };
  }
  if (!isCommand(command)) {
    throw new UsageError(`Unknown command "${command}"`);
  }
  if (command !== 'adopt' && command !== 'skill' && positionals.length > 1) {
    throw new UsageError(
      `Unexpected arguments: ${positionals.slice(1).join(' ')}`,
    );
  }
  const provided = Object.keys(values);
  if (baselineRef !== undefined && !provided.includes('baseline')) {
    provided.push('baseline');
  }
  rejectOptions(command, provided);
  if (command === 'skill') rejectSkillOptions(positionals[1], provided);

  const scope: Scope | undefined =
    values.project !== undefined
      ? 'project'
      : values.global
        ? 'global'
        : undefined;
  return {
    kind: 'command',
    command,
    positionals,
    values,
    ...(baselineRef !== undefined ? { baselineRef } : {}),
    ...(scope ? { scope } : {}),
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
    ...(values.project !== undefined ? { projectDir: values.project } : {}),
  };
}
