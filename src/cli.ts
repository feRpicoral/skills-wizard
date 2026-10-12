#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, styleText } from 'node:util';

import * as clack from '@clack/prompts';

import type { Scope } from './blocks/library.ts';
import { runDoctor } from './commands/doctor.ts';
import { runInit } from './commands/init.ts';
import { runMenu } from './commands/menu.ts';
import { runSync } from './commands/sync.ts';
import { createContext } from './context.ts';
import {
  AgentsConfigError,
  CancelledError,
  isSystemError,
  UsageError,
} from './errors.ts';
import { isToolId, TOOL_IDS, type ToolId } from './tools/registry.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

const HELP = `Usage: agents-config [command] [options]

Commands:
  init     Install instructions system-wide or into a project
  sync     Re-apply everything recorded in a manifest
  doctor   Check an install and report problems
  help     Show this help

Run without a command in a terminal to open the interactive menu.

Options:
  --global              System-wide scope (default for sync and doctor)
  --project <dir>       Project scope
  --tools <ids>         Comma-separated tools: ${TOOL_IDS.join(', ')}
                        (an empty list removes what was installed for every tool)
  --blocks <ids>        Comma-separated block ids, for example core/no-ai-tells
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
  var: { type: 'string', multiple: true },
  'link-command': { type: 'boolean' },
  local: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type OptionName = keyof typeof OPTIONS;

const COMMANDS = ['init', 'sync', 'doctor'] as const;

type Command = (typeof COMMANDS)[number];

const ALLOWED: Readonly<Record<Command, readonly OptionName[]>> = {
  init: [
    'global',
    'project',
    'tools',
    'blocks',
    'var',
    'link-command',
    'local',
    'yes',
    'dry-run',
  ],
  sync: ['global', 'project', 'yes', 'dry-run'],
  doctor: ['global', 'project'],
};

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
      args: argv,
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
  if (positionals.length > 1) {
    throw new UsageError(
      `Unexpected arguments: ${positionals.slice(1).join(' ')}`,
    );
  }
  if (values.global && values.project !== undefined) {
    throw new UsageError('Use either --global or --project, not both.');
  }

  const terminal = process.stdin.isTTY && process.stdout.isTTY;
  const command = positionals[0];
  if (command === undefined || command === 'help') {
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
      return runInit(ctx, {
        variables: parseVariables(values.var),
        yes,
        dryRun,
        ...(scope ? { scope } : {}),
        ...projectDir,
        ...(tools ? { tools } : {}),
        ...(blocks ? { blocks } : {}),
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
    case 'doctor':
      return runDoctor(ctx, { scope: scope ?? 'global', ...projectDir });
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
