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
  --baseline [none|ref] skill eval: run without_skill baseline (default; use --no-baseline or --baseline none to skip, or --baseline <ref> to compare against a git ref)
  --compare <ref>       skill eval: also run old_skill snapshot from <ref>:skills/<name>
  --case <id>           skill eval: filter to a single eval case ID
  --cases <ids>         skill eval: comma-separated eval case IDs
  --parallel <n>        skill eval/triggers: concurrent runs (default: 2)
  --timeout <seconds>   skill eval/triggers: per-run timeout in seconds
  --sandbox             skill eval/triggers: pass --sandbox to runners that support it
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

function normalizeBaselineArgv(argv: readonly string[]): string[] {
  const normalized: string[] = [];
  let positionalCount = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') {
      normalized.push(...argv.slice(index));
      break;
    }
    if (token.startsWith('--baseline=')) {
      const val = token.slice('--baseline='.length).trim();
      if (val === '' || val === 'true') {
        normalized.push('--baseline');
      } else if (val === 'false' || val === 'none') {
        normalized.push('--no-baseline');
      } else {
        normalized.push('--no-baseline', '--compare', val);
      }
      continue;
    }
    if (token === '--baseline') {
      const next = argv[index + 1];
      if (next === 'none' || next === 'false') {
        normalized.push('--no-baseline');
        index += 1;
        continue;
      }
      if (next === 'true') {
        normalized.push('--baseline');
        index += 1;
        continue;
      }
      if (next !== undefined && !next.startsWith('-') && positionalCount >= 3) {
        normalized.push('--no-baseline', '--compare', next);
        index += 1;
        continue;
      }
      normalized.push('--baseline');
      continue;
    }
    if (STRING_OPTIONS.has(token)) {
      normalized.push(token);
      const next = argv[index + 1];
      if (next !== undefined) {
        normalized.push(next);
        index += 1;
      }
      continue;
    }
    if (!token.startsWith('-')) {
      positionalCount += 1;
    }
    normalized.push(token);
  }

  return normalized;
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

function parsePositiveInt({
  value,
  flagName,
}: ParseFlagParams): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
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
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new UsageError(`--${flagName} must be a number, got "${value}"`);
  }
  return parsed;
}

function rejectOptions(command: Command, provided: readonly string[]): void {
  const allowed: readonly string[] = ALLOWED[command];
  const extra = provided.filter((name) => !allowed.includes(name));
  if (extra.length > 0) {
    throw new UsageError(`${flags(extra)} does not apply to ${command}`);
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
  try {
    parsed = parseArgs({
      args: normalizeBaselineArgv(argv),
      options: OPTIONS,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
  } catch (error) {
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
    if (command === undefined && terminal) {
      const provided = Object.keys(values);
      if (provided.length > 0) {
        throw new UsageError(
          `${flags(provided)} must follow a command such as init`,
        );
      }
      return runMenu(
        createContext({
          repoRoot: REPO_ROOT,
          cwd: process.cwd(),
          interactive: true,
        }),
      );
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
  rejectOptions(command, Object.keys(values));

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
        ...(values.baseline !== undefined ? { baseline: values.baseline } : {}),
        ...(values.compare !== undefined ? { compare: values.compare } : {}),
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
