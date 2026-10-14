import { parseArgs } from 'node:util';

import type { Scope } from './blocks/library.ts';
import {
  buildSkillCommandOptions,
  normalizeBaselineArgv,
  type NormalizedArgv,
  parseFloatFlag,
  parseList,
  parsePositiveInt,
} from './cli-skill-args.ts';
import { UsageError } from './errors.ts';
import { SKILL_MODES, type SkillMode } from './skills/install.ts';
import { isToolId, type ToolId } from './tools/registry.ts';

export {
  buildSkillCommandOptions,
  normalizeBaselineArgv,
  type NormalizedArgv,
  parseFloatFlag,
  parseList,
  parsePositiveInt,
};

export const OPTIONS = {
  global: { type: 'boolean' },
  project: { type: 'string' },
  tools: { type: 'string' },
  blocks: { type: 'string' },
  skills: { type: 'string' },
  'skill-mode': { type: 'string' },
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

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function flags(names: readonly string[]): string {
  return names.map((name) => `--${name}`).join(', ');
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
    const normalized = normalizeBaselineArgv(argv, STRING_OPTIONS);
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
