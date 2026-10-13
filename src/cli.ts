#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';

import * as clack from '@clack/prompts';

import type { Scope } from './blocks/library.ts';
import { runAdopt } from './commands/adopt.ts';
import { runDoctor } from './commands/doctor.ts';
import { runInit } from './commands/init.ts';
import { runMenu } from './commands/menu.ts';
import { runSkill } from './commands/skill.ts';
import { runSync } from './commands/sync.ts';
import { runUpdate } from './commands/update.ts';
import { createContext } from './context.ts';
import {
  AgentsConfigError,
  CancelledError,
  isSystemError,
  UsageError,
} from './errors.ts';
import { SKILL_MODES, type SkillMode } from './skills/install.ts';
import { isToolId, TOOL_IDS, type ToolId } from './tools/registry.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

const HELP = `Usage: agents-config [command] [options]

Commands:
  init                      Install instructions and skills system-wide or into a project
  sync                      Re-apply everything recorded in a manifest
  update                    Fetch skill updates, show changes and risk flags, and refresh installs
  adopt [skill...]          Take over existing unmanaged skills after backing them up
  doctor                    Check an install and report problems
  skill validate [path...]  Validate skill directories or --catalog
  skill new <name>          Scaffold a new first-party skill in skills/<name>
  skill eval <name>         Run with-skill vs baseline benchmark and grade assertions
  skill triggers <name>     Measure trigger precision/recall on trigger_queries.json
  skill report <name> [dir] Regenerate report.md from an existing benchmark iteration or run-dir
  help                      Show this help

Run without a command in a terminal to open the interactive menu.

Options:
  --global              System-wide scope (default for sync and doctor)
  --project <dir>       Project scope
  --tools <ids>         Comma-separated tools: ${TOOL_IDS.join(', ')}
                        (an empty list removes what was installed for every tool)
  --blocks <ids>        Comma-separated block ids, for example core/no-ai-tells
  --skills <names>      Comma-separated skills from catalog.yaml or skills/
                        (an empty list removes every installed skill)
  --skill-mode <mode>   System-wide first-party skills: copy (default) or link
  --catalog             skill validate: validate every skill in catalog.yaml
  --template <kind>     skill new: basic (default), scripted, or reference-heavy
  --with-evals          skill new: also scaffold evals/evals.json and trigger_queries.json
  --runner <name>       skill eval/triggers: agy, claude, codex, gemini, or fake
  --binary <path>       skill eval/triggers: override runner CLI binary path
  --runs <n>            skill eval/triggers: runs per configuration or query (default: 1)
  --baseline [none|ref] skill eval: run the without_skill baseline (default). --no-baseline or
                        --baseline none skips it; --baseline <ref> compares against the skill at a
                        git ref instead (cannot be combined with --compare)
  --compare <ref>       skill eval: also run an old_skill snapshot of the skill folder at <ref>, read
                        from the git repository that contains the skill
  --case <id>           skill eval: filter to a single eval case ID
  --cases <ids>         skill eval: comma-separated eval case IDs
  --parallel <n>        skill eval/triggers: concurrent runs (default: 2)
  --timeout <seconds>   skill eval/triggers: per-run timeout in seconds
  --sandbox             skill eval/triggers: pass --sandbox to runners that support it
                        (warns when the runner cannot; runs are otherwise not confined)
  --keep-workdirs       skill eval/triggers: keep temporary workdirs for debugging
  --split <name>        skill triggers: train, validation, or all (default: all)
  --threshold <0..1>    skill triggers: pass threshold for positive queries (default: 0.5)
  --var <name=value>    Block variable, repeatable
  --link-command        Link the agents-config command into ~/.local/bin
  --local               Project scope: keep the files out of git
  -y, --yes             Apply without asking (required without a terminal)
  --dry-run             Show the plan without writing anything
  -h, --help            Show this help
  -v, --version         Show the version`;

const OPTIONS = {
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

type OptionName = keyof typeof OPTIONS;

const STRING_OPTIONS = new Set<string>(
  Object.entries(OPTIONS)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => `--${name}`),
);

const COMMANDS = [
  'init',
  'sync',
  'update',
  'adopt',
  'doctor',
  'skill',
] as const;

type Command = (typeof COMMANDS)[number];

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

// `skill eval <name>` has exactly three positionals: skill, eval and <name>.
const SKILL_EVAL_POSITIONALS = 3;

interface NormalizedArgv {
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

function normalizeBaselineArgv(argv: readonly string[]): NormalizedArgv {
  const args: string[] = [];
  let baselineRef: string | undefined;
  const refsAllowed = countPositionals(argv) >= SKILL_EVAL_POSITIONALS;

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

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTools(value: string | undefined): ToolId[] | undefined {
  const ids = parseList(value);
  if (!ids) return undefined;
  const unknown = ids.filter((id) => !isToolId(id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown tools: ${unknown.join(', ')}`);
  }
  return ids.filter(isToolId);
}

function parseSkillMode(value: string | undefined): SkillMode | undefined {
  if (value === undefined) return undefined;
  const mode = SKILL_MODES.find((candidate) => candidate === value);
  if (!mode) {
    throw new UsageError(
      `--skill-mode must be one of ${SKILL_MODES.join(', ')}, got "${value}"`,
    );
  }
  return mode;
}

function parseVariables(values: string[] | undefined): Record<string, string> {
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

function parsePositiveInt({
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

function parseFloatFlag({
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

async function version(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  return packageJson.version;
}

async function main(argv: string[]): Promise<number> {
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
  const print = (line: string) => process.stdout.write(`${line}\n`);
  if (values.help) {
    print(HELP);
    return 0;
  }
  if (values.version) {
    print(await version());
    return 0;
  }
  if (values.global && values.project !== undefined) {
    throw new UsageError('Use either --global or --project, not both.');
  }

  const terminal = process.stdin.isTTY && process.stdout.isTTY;
  const command = positionals[0];
  if (command === undefined || command === 'help') {
    if (positionals.length > 1) {
      throw new UsageError(
        `Unexpected arguments: ${positionals.slice(1).join(' ')}`,
      );
    }
    if (command === undefined) {
      const provided = Object.keys(values);
      if (provided.length > 0) {
        throw new UsageError(
          `${flags(provided)} must follow a command such as init`,
        );
      }
      if (terminal) {
        return runMenu(
          createContext({
            repoRoot: REPO_ROOT,
            cwd: process.cwd(),
            interactive: true,
          }),
        );
      }
    }
    print(HELP);
    return 0;
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

  const ctx = createContext({
    repoRoot: REPO_ROOT,
    cwd: process.cwd(),
    interactive: terminal,
  });
  const scope: Scope | undefined =
    values.project !== undefined
      ? 'project'
      : values.global
        ? 'global'
        : undefined;
  const yes = values.yes ?? false;
  const dryRun = values['dry-run'] ?? false;
  const projectDir =
    values.project !== undefined ? { projectDir: values.project } : {};

  switch (command) {
    case 'init': {
      if (terminal && !yes) clack.intro('agents-config');
      const tools = parseTools(values.tools);
      const blocks = parseList(values.blocks);
      const skills = parseList(values.skills);
      const skillMode = parseSkillMode(values['skill-mode']);
      return runInit(ctx, {
        variables: parseVariables(values.var),
        yes,
        dryRun,
        ...(scope ? { scope } : {}),
        ...projectDir,
        ...(tools ? { tools } : {}),
        ...(blocks ? { blocks } : {}),
        ...(skills ? { skills } : {}),
        ...(skillMode ? { skillMode } : {}),
        ...(values['link-command'] !== undefined
          ? { linkCommand: values['link-command'] }
          : {}),
        ...(values.local !== undefined ? { keepLocal: values.local } : {}),
      });
    }
    case 'sync':
      return runSync(ctx, {
        scope: scope ?? 'global',
        yes,
        dryRun,
        ...projectDir,
      });
    case 'update':
      if (terminal && !yes) clack.intro('agents-config');
      return runUpdate(ctx, { yes, dryRun });
    case 'adopt': {
      if (terminal && !yes) clack.intro('agents-config');
      const tools = parseTools(values.tools);
      const fromFlag = parseList(values.skills) ?? [];
      const names = [...positionals.slice(1), ...fromFlag];
      return runAdopt(ctx, {
        names,
        ...(tools ? { tools } : {}),
        yes,
        dryRun,
      });
    }
    case 'doctor':
      return runDoctor(ctx, { scope: scope ?? 'global', ...projectDir });
    case 'skill': {
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
      return runSkill(ctx, {
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
      });
    }
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CancelledError) {
    clack.cancel(error.message);
    process.exitCode = 1;
  } else if (error instanceof UsageError) {
    process.stderr.write(
      `${styleText('red', error.message)}\nRun agents-config --help for usage.\n`,
    );
    process.exitCode = 2;
  } else if (error instanceof AgentsConfigError || isSystemError(error)) {
    process.stderr.write(`${styleText('red', error.message)}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
