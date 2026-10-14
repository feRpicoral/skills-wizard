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
import type { McpSubcommand } from './commands/mcp.ts';
import { UsageError } from './errors.ts';
import {
  isPresetChoice,
  isProjectStyle,
  PRESET_IDS,
  type PresetChoice,
  PROJECT_STYLES,
  type ProjectStyle,
} from './project/presets.ts';
import { isGitRef } from './skills/catalog.ts';
import {
  DISCOVER_SOURCES,
  type DiscoverSource,
  isDiscoverSource,
} from './skills/discover.ts';
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
  mcp: { type: 'string' },
  'skill-mode': { type: 'string' },
  preset: { type: 'string' },
  style: { type: 'string' },
  source: { type: 'string' },
  category: { type: 'string' },
  ref: { type: 'string' },
  'include-offensive': { type: 'boolean' },
  install: { type: 'boolean' },
  official: { type: 'boolean' },
  limit: { type: 'string' },
  add: { type: 'boolean' },
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
  'add',
  'sync',
  'update',
  'adopt',
  'doctor',
  'skill',
  'mcp',
] as const;

export type Command = (typeof COMMANDS)[number];

const ALLOWED: Readonly<Record<Command, readonly OptionName[]>> = {
  init: [
    'global',
    'project',
    'tools',
    'blocks',
    'skills',
    'mcp',
    'skill-mode',
    'preset',
    'style',
    'var',
    'link-command',
    'local',
    'yes',
    'dry-run',
  ],
  add: [
    'source',
    'category',
    'ref',
    'include-offensive',
    'install',
    'global',
    'project',
    'tools',
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
  mcp: [
    'global',
    'project',
    'tools',
    'official',
    'limit',
    'add',
    'yes',
    'dry-run',
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
      `--style must be one of ${PROJECT_STYLES.join(', ')}, strict, got "${value}"`,
    );
  }
  return value;
}

export function parseDiscoverSource(
  value: string | undefined,
): DiscoverSource | undefined {
  if (value === undefined) return undefined;
  if (!isDiscoverSource(value)) {
    throw new UsageError(
      `--source must be one of ${DISCOVER_SOURCES.join(', ')}, got "${value}"`,
    );
  }
  return value;
}

export function parseRefFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isGitRef(value)) {
    throw new UsageError(
      `--ref must be a valid branch, tag or commit SHA, got "${value}"`,
    );
  }
  return value;
}

export function parseCategoryFlag(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new UsageError('--category must not be empty');
  }
  return trimmed;
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

const MCP_SUBCOMMAND_OPTIONS: Readonly<
  Record<McpSubcommand, readonly OptionName[]>
> = {
  list: ['global', 'project'],
  add: ['global', 'project', 'tools', 'yes', 'dry-run'],
  remove: ['global', 'project', 'yes', 'dry-run'],
  search: ['official', 'limit', 'add', 'yes', 'dry-run'],
};

export function parseMcpSubcommand(value: string | undefined): McpSubcommand {
  if (value === undefined || value === 'list') return 'list';
  if (value === 'add' || value === 'remove' || value === 'search') {
    return value;
  }
  throw new UsageError(
    'Usage: agents-config mcp [list | add <name...> | remove <name...> | search <query>]',
  );
}

function rejectMcpOptions(
  subcommand: McpSubcommand,
  provided: readonly string[],
): void {
  const allowed: readonly string[] = MCP_SUBCOMMAND_OPTIONS[subcommand];
  const extra = provided.filter((name) => !allowed.includes(name));
  if (extra.length > 0) {
    throw new UsageError(`${flags(extra)} does not apply to mcp ${subcommand}`);
  }
  if (subcommand === 'search' && !provided.includes('add')) {
    const addOnly = provided.filter(
      (name) => name === 'yes' || name === 'dry-run',
    );
    if (addOnly.length > 0) {
      throw new UsageError(
        `${flags(addOnly)} only applies to mcp search with --add`,
      );
    }
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

/**
 * Parses and validates CLI arguments into a discriminated {@link ParsedCommand},
 * normalizing `--baseline` arguments and rejecting options that do not apply to
 * the target command or `skill` subcommand.
 */
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
  if (
    command !== 'add' &&
    command !== 'adopt' &&
    command !== 'skill' &&
    command !== 'mcp' &&
    positionals.length > 1
  ) {
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
  if (command === 'mcp') {
    const subcommand = parseMcpSubcommand(positionals[1]);
    rejectMcpOptions(subcommand, provided);
  }

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
