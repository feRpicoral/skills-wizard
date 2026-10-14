import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { CancelledError, isSystemError, SkillsWizardError } from '../errors.ts';
import { promptProjectDir } from '../prompts/selection.ts';
import { runAdd } from './add.ts';
import { runAdopt } from './adopt.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { runMcp } from './mcp.ts';
import { runSync } from './sync.ts';
import { runUpdate } from './update.ts';

export const BACK = '__back';
export const EXIT = '__exit';

export interface MenuAction {
  kind: 'action';
  id: string;
  label: string;
  hint?: string;
  run: (ctx: Context) => Promise<number>;
}

export interface Submenu {
  kind: 'submenu';
  id: string;
  label: string;
  hint?: string;
  menu: Menu;
}

export type MenuEntry = MenuAction | Submenu;

export interface Menu {
  message: string;
  entries: readonly MenuEntry[];
}

export interface MenuOption {
  value: string;
  label: string;
  hint?: string;
}

/** The terminal side of the menu, injectable so the loop runs in tests. */
export interface MenuIo {
  /** Resolves to the chosen value, or to a symbol when the prompt is cancelled. */
  select: (params: {
    message: string;
    options: MenuOption[];
  }) => Promise<string | symbol>;
  intro: (title: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  outro: (message: string) => void;
}

export const clackMenuIo: MenuIo = {
  select: ({ message, options }) => clack.select<string>({ message, options }),
  intro: (title) => clack.intro(title),
  info: (message) => clack.log.info(message),
  warn: (message) => clack.log.warn(message),
  error: (message) => clack.log.error(message),
  outro: (message) => clack.outro(message),
};

const PROMPT_ONLY = { yes: false, dryRun: false } as const;

async function promptMcpQuery(): Promise<string> {
  const query = await clack.text({
    message: 'Search the MCP registry for',
    placeholder: 'for example: sentry',
    validate: (value) =>
      value?.trim()
        ? undefined
        : 'Enter a search query, or press esc to go back',
  });

  if (clack.isCancel(query)) throw new CancelledError('Cancelled');

  return query.trim();
}

export function buildMainMenu(): Menu {
  return {
    message: 'What do you want to do?',
    entries: [
      {
        kind: 'action',
        id: 'global',
        label: 'Set up system-wide instructions',
        hint: 'every project',
        run: (ctx) =>
          runInit(ctx, { scope: 'global', variables: {}, ...PROMPT_ONLY }),
      },
      {
        kind: 'action',
        id: 'project',
        label: 'Set up a project',
        hint: 'one directory',
        run: (ctx) =>
          runInit(ctx, { scope: 'project', variables: {}, ...PROMPT_ONLY }),
      },
      {
        kind: 'submenu',
        id: 'skills',
        label: 'Skills',
        hint: 'search, update, adopt',
        menu: {
          message: 'Skills',
          entries: [
            {
              kind: 'action',
              id: 'add',
              label: 'Search and add a third-party skill',
              run: (ctx) => runAdd(ctx, PROMPT_ONLY),
            },
            {
              kind: 'action',
              id: 'update',
              label: 'Update installed third-party skills',
              run: (ctx) => runUpdate(ctx, PROMPT_ONLY),
            },
            {
              kind: 'action',
              id: 'adopt',
              label: 'Adopt existing unmanaged skills',
              run: (ctx) => runAdopt(ctx, { names: [], ...PROMPT_ONLY }),
            },
          ],
        },
      },
      {
        kind: 'submenu',
        id: 'mcp',
        label: 'MCP servers',
        hint: 'curated list, registry search',
        menu: {
          message: 'MCP servers',
          entries: [
            {
              kind: 'action',
              id: 'mcp-list',
              label: 'List curated MCP servers',
              run: (ctx) =>
                runMcp(ctx, { subcommand: 'list', args: [], ...PROMPT_ONLY }),
            },
            {
              kind: 'action',
              id: 'mcp-search',
              label: 'Search the MCP registry',
              run: async (ctx) => {
                const query = await promptMcpQuery();

                return runMcp(ctx, {
                  subcommand: 'search',
                  args: [query],
                  ...PROMPT_ONLY,
                });
              },
            },
          ],
        },
      },
      {
        kind: 'submenu',
        id: 'maintenance',
        label: 'Sync and health checks',
        hint: 'sync, doctor',
        menu: {
          message: 'Sync and health checks',
          entries: [
            {
              kind: 'action',
              id: 'sync-global',
              label: 'Sync the system-wide install',
              run: (ctx) => runSync(ctx, { scope: 'global', ...PROMPT_ONLY }),
            },
            {
              kind: 'action',
              id: 'sync-project',
              label: 'Sync a project',
              run: async (ctx) =>
                runSync(ctx, {
                  scope: 'project',
                  projectDir: await promptProjectDir(ctx.cwd),
                  ...PROMPT_ONLY,
                }),
            },
            {
              kind: 'action',
              id: 'doctor-global',
              label: 'Check the system-wide install',
              run: (ctx) => runDoctor(ctx, { scope: 'global' }),
            },
            {
              kind: 'action',
              id: 'doctor-project',
              label: 'Check a project',
              run: async (ctx) =>
                runDoctor(ctx, {
                  scope: 'project',
                  projectDir: await promptProjectDir(ctx.cwd),
                }),
            },
          ],
        },
      },
    ],
  };
}

/** The options shown for a menu: its entries, then Back (below the root) and Exit. */
export function menuOptions(menu: Menu, isRoot: boolean): MenuOption[] {
  const options: MenuOption[] = menu.entries.map((entry) => ({
    value: entry.id,
    label: entry.kind === 'submenu' ? `${entry.label} ›` : entry.label,
    ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
  }));

  if (!isRoot) {
    options.push({ value: BACK, label: '← Back', hint: 'previous menu' });
  }

  options.push({ value: EXIT, label: 'Exit' });

  return options;
}

async function runAction(
  ctx: Context,
  action: MenuAction,
  io: MenuIo,
): Promise<void> {
  try {
    const code = await action.run(ctx);

    if (code !== 0) io.warn(`${action.label} finished with problems.`);
  } catch (error) {
    if (error instanceof CancelledError) {
      io.info('Cancelled. Back to the menu.');
    } else if (error instanceof SkillsWizardError || isSystemError(error)) {
      io.error(error.message);
    } else {
      throw error;
    }
  }
}

export interface RunMenuLoopParams {
  ctx: Context;
  menu: Menu;
  io: MenuIo;
}

/**
 * Shows `menu` until the user exits. Actions return to the menu they were
 * started from, whether they finish, fail or are cancelled. Back (or esc)
 * returns to the parent menu, and Exit (or esc on the main menu) leaves.
 */
export async function runMenuLoop({
  ctx,
  menu,
  io,
}: RunMenuLoopParams): Promise<number> {
  const stack: Menu[] = [menu];

  for (;;) {
    const current = stack.at(-1)!;
    const isRoot = stack.length === 1;
    const choice = await io.select({
      message: current.message,
      options: menuOptions(current, isRoot),
    });

    if (choice === EXIT || (isRoot && typeof choice === 'symbol')) break;

    if (choice === BACK || typeof choice === 'symbol') {
      stack.pop();
      continue;
    }

    const entry = current.entries.find((candidate) => candidate.id === choice);

    if (entry?.kind === 'submenu') stack.push(entry.menu);
    else if (entry) await runAction(ctx, entry, io);
  }

  io.outro('See you next time.');

  return 0;
}

export interface RunMenuOptions {
  /** Printed once before the menu opens, for example the launch banner. */
  banner?: string;
  io?: MenuIo;
}

export async function runMenu(
  ctx: Context,
  { banner, io = clackMenuIo }: RunMenuOptions = {},
): Promise<number> {
  if (banner !== undefined) ctx.print(banner);
  io.intro('Main menu');

  return runMenuLoop({ ctx, menu: buildMainMenu(), io });
}
