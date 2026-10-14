#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styleText } from 'node:util';

import * as clack from '@clack/prompts';

import {
  buildSkillCommandOptions,
  parseCategoryFlag,
  parseCommand,
  type ParsedCommand,
  parseDiscoverSource,
  parseList,
  parsePreset,
  parseProjectStyle,
  parseRefFlag,
  parseSkillMode,
  parseTools,
  parseVariables,
} from './cli-args.ts';
import { runAdd } from './commands/add.ts';
import { runAdopt } from './commands/adopt.ts';
import { runDoctor } from './commands/doctor.ts';
import { runInit } from './commands/init.ts';
import { runMenu } from './commands/menu.ts';
import { runSkill } from './commands/skill.ts';
import { runSync } from './commands/sync.ts';
import { runUpdate } from './commands/update.ts';
import { type Context, createContext } from './context.ts';
import {
  AgentsConfigError,
  CancelledError,
  isSystemError,
  UsageError,
} from './errors.ts';
import { PRESET_IDS } from './project/presets.ts';
import { DISCOVER_SOURCES } from './skills/discover.ts';
import { TOOL_IDS } from './tools/registry.ts';

export { isSystemError };

const REPO_ROOT = join(import.meta.dirname, '..');

const HELP = `Usage: agents-config [command] [options]

Commands:
  init                      Install instructions and skills system-wide or into a project
  add [query|url]           Search or resolve a third-party skill and add it to catalog.yaml
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
  --preset <id>         Project preset: ${PRESET_IDS.join(', ')}, none
  --style <mode>        Project instructions style: lean (default with a system-wide install),
                        self-contained, or strict (alias for self-contained)
  --source <kind>       add: search source (${DISCOVER_SOURCES.join(', ')}; default: all)
  --category <name>     add: catalog category (and filter for awesome index search)
  --ref <ref>           add: pin repository branch, tag, or commit SHA
  --include-offensive   add: include offensive security skills in awesome index search
  --install             add: also install the skill after adding it to catalog.yaml
  --catalog             skill validate: validate every skill in catalog.yaml
  --template <kind>     skill new: basic (default), scripted, or reference-heavy
  --with-evals          skill new: also scaffold evals/evals.json and trigger_queries.json
  --runner <name>       skill eval/triggers: agy, claude, codex, gemini, or fake
  --binary <path>       skill eval/triggers: override runner CLI binary path
  --runs <n>            skill eval/triggers: runs per configuration or query (default: 1)
  --baseline [none|ref] skill eval: run the without_skill baseline (default). --no-baseline or
                        --baseline none skips it; --baseline <ref> compares against the skill at a
                        git ref instead (cannot be combined with --compare)
  --compare <ref|list>  skill eval: run an old_skill snapshot at git <ref>, or compare against
                        competing skills (<skill-a>,<skill-b>) side by side
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

async function version(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  return packageJson.version;
}

interface DispatchCommandParams {
  ctx: Context;
  terminal: boolean;
  parsed: Extract<ParsedCommand, { kind: 'command' }>;
}

function dispatchCommand({
  ctx,
  terminal,
  parsed: {
    command,
    positionals,
    values,
    baselineRef,
    scope,
    yes,
    dryRun,
    projectDir,
  },
}: DispatchCommandParams): Promise<number> {
  const projectOption = projectDir !== undefined ? { projectDir } : {};
  switch (command) {
    case 'init': {
      if (terminal && !yes) clack.intro('agents-config');
      const tools = parseTools(values.tools);
      const blocks = parseList(values.blocks);
      const skills = parseList(values.skills);
      const skillMode = parseSkillMode(values['skill-mode']);
      const preset = parsePreset(values.preset);
      const style = parseProjectStyle(values.style);
      return runInit(ctx, {
        variables: parseVariables(values.var),
        yes,
        dryRun,
        ...(scope ? { scope } : {}),
        ...projectOption,
        ...(tools ? { tools } : {}),
        ...(blocks ? { blocks } : {}),
        ...(skills ? { skills } : {}),
        ...(skillMode ? { skillMode } : {}),
        ...(preset ? { preset } : {}),
        ...(style ? { style } : {}),
        ...(values['link-command'] !== undefined
          ? { linkCommand: values['link-command'] }
          : {}),
        ...(values.local !== undefined ? { keepLocal: values.local } : {}),
      });
    }
    case 'add': {
      if (terminal && !yes) clack.intro('agents-config');
      const tools = parseTools(values.tools);
      const source = parseDiscoverSource(values.source);
      const category = parseCategoryFlag(values.category);
      const ref = parseRefFlag(values.ref);
      const target = positionals.slice(1).join(' ').trim();
      return runAdd(ctx, {
        ...(target ? { target } : {}),
        ...(source ? { source } : {}),
        ...(category ? { category } : {}),
        ...(ref ? { ref } : {}),
        ...(values['include-offensive'] !== undefined
          ? { includeOffensive: values['include-offensive'] }
          : {}),
        ...(values.install !== undefined ? { install: values.install } : {}),
        ...(scope ? { scope } : {}),
        ...projectOption,
        ...(tools ? { tools } : {}),
        yes,
        dryRun,
      });
    }
    case 'sync':
      return runSync(ctx, {
        scope: scope ?? 'global',
        yes,
        dryRun,
        ...projectOption,
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
      return runDoctor(ctx, { scope: scope ?? 'global', ...projectOption });
    case 'skill':
      return runSkill(
        ctx,
        buildSkillCommandOptions({ values, positionals, baselineRef }),
      );
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv);
  const print = (line: string) => process.stdout.write(`${line}\n`);
  if (parsed.kind === 'help') return (print(HELP), 0);
  if (parsed.kind === 'version') return (print(await version()), 0);

  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (parsed.kind === 'default') {
    return terminal
      ? runMenu(
          createContext({
            repoRoot: REPO_ROOT,
            cwd: process.cwd(),
            interactive: true,
          }),
        )
      : (print(HELP), 0);
  }

  const ctx = createContext({
    repoRoot: REPO_ROOT,
    cwd: process.cwd(),
    interactive: terminal,
  });
  return dispatchCommand({ ctx, terminal, parsed });
}

if (import.meta.main) {
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
}
