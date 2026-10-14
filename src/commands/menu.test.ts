import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Context } from '../context.ts';
import { CancelledError, UsageError } from '../errors.ts';
import { commandSandbox } from '../test-support/command-fixtures.ts';
import {
  BACK,
  buildMainMenu,
  EXIT,
  type Menu,
  type MenuIo,
  type MenuOption,
  menuOptions,
  runMenu,
  runMenuLoop,
} from './menu.ts';

const CANCEL = Symbol('cancel');

interface ScriptedIo {
  io: MenuIo;
  /** The menu message and option values shown at each prompt. */
  screens: { message: string; values: string[] }[];
  logs: string[];
}

// Answers each prompt with the next scripted choice; running out of answers
// fails the test instead of hanging the loop.
function scriptedIo(choices: (string | symbol)[]): ScriptedIo {
  const screens: ScriptedIo['screens'] = [];
  const logs: string[] = [];
  const queue = [...choices];

  return {
    screens,
    logs,
    io: {
      select: ({
        message,
        options,
      }: {
        message: string;
        options: MenuOption[];
      }) => {
        screens.push({
          message,
          values: options.map((option) => option.value),
        });
        const next = queue.shift();

        if (next === undefined) {
          return Promise.reject(
            new Error(`No scripted answer for "${message}"`),
          );
        }

        return Promise.resolve(next);
      },
      intro: (title) => logs.push(`intro: ${title}`),
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
      error: (message) => logs.push(`error: ${message}`),
      outro: (message) => logs.push(`outro: ${message}`),
    },
  };
}

function testMenu(run: (ctx: Context) => Promise<number>): {
  menu: Menu;
  calls: () => number;
} {
  let count = 0;
  const menu: Menu = {
    message: 'Main',
    entries: [
      {
        kind: 'action',
        id: 'act',
        label: 'Act',
        run: (ctx) => {
          count += 1;
          return run(ctx);
        },
      },
      {
        kind: 'submenu',
        id: 'sub',
        label: 'Sub',
        menu: {
          message: 'Sub',
          entries: [
            {
              kind: 'action',
              id: 'inner',
              label: 'Inner',
              run: () => Promise.resolve(0),
            },
          ],
        },
      },
    ],
  };

  return { menu, calls: () => count };
}

test('menuOptions adds Back below the root and Exit everywhere', () => {
  const { menu } = testMenu(() => Promise.resolve(0));
  const sub = menu.entries[1]!;
  assert.equal(sub.kind, 'submenu');

  assert.deepEqual(
    menuOptions(menu, true).map((option) => option.value),
    ['act', 'sub', EXIT],
  );
  assert.deepEqual(
    menuOptions(sub.menu, false).map((option) => option.value),
    ['inner', BACK, EXIT],
  );
  assert.equal(menuOptions(menu, true)[1]!.label, 'Sub ›');
});

test('the menu returns after an action instead of exiting', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { menu, calls } = testMenu(() => Promise.resolve(0));
  const { io, screens, logs } = scriptedIo(['act', 'act', EXIT]);

  const code = await runMenuLoop({ ctx: createCtx().ctx, menu, io });

  assert.equal(code, 0);
  assert.equal(calls(), 2);
  assert.deepEqual(
    screens.map((screen) => screen.message),
    ['Main', 'Main', 'Main'],
  );
  assert.deepEqual(logs, ['outro: See you next time.']);
});

test('Back and esc return to the parent menu; Exit leaves from a submenu', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { menu } = testMenu(() => Promise.resolve(0));
  const { io, screens } = scriptedIo([
    'sub',
    'inner',
    BACK,
    'sub',
    CANCEL,
    'sub',
    EXIT,
  ]);

  await runMenuLoop({ ctx: createCtx().ctx, menu, io });

  assert.deepEqual(
    screens.map((screen) => screen.message),
    ['Main', 'Sub', 'Sub', 'Main', 'Sub', 'Main', 'Sub'],
  );
});

test('esc on the main menu exits gracefully', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { menu, calls } = testMenu(() => Promise.resolve(0));
  const { io, logs } = scriptedIo([CANCEL]);

  assert.equal(await runMenuLoop({ ctx: createCtx().ctx, menu, io }), 0);
  assert.equal(calls(), 0);
  assert.deepEqual(logs, ['outro: See you next time.']);
});

test('cancelled, failing and unsuccessful actions keep the menu open', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const outcomes = [
    () => Promise.reject(new CancelledError('Cancelled')),
    () => Promise.reject(new UsageError('Nothing recorded')),
    () => Promise.resolve(1),
  ];
  const { menu, calls } = testMenu(() => outcomes.shift()!());
  const { io, logs } = scriptedIo(['act', 'act', 'act', EXIT]);

  await runMenuLoop({ ctx: createCtx().ctx, menu, io });

  assert.equal(calls(), 3);
  assert.deepEqual(logs, [
    'info: Cancelled. Back to the menu.',
    'error: Nothing recorded',
    'warn: Act finished with problems.',
    'outro: See you next time.',
  ]);
});

test('unexpected errors still propagate out of the menu', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { menu } = testMenu(() => Promise.reject(new TypeError('bug')));
  const { io } = scriptedIo(['act']);

  await assert.rejects(runMenuLoop({ ctx: createCtx().ctx, menu, io }), {
    name: 'TypeError',
  });
});

test('every main-menu submenu offers Back and Exit, and ids are unique', () => {
  const menu = buildMainMenu();
  const ids = new Set<string>();

  for (const entry of menu.entries) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);

    if (entry.kind !== 'submenu') continue;

    const values = menuOptions(entry.menu, false).map((option) => option.value);
    assert.deepEqual(values.slice(-2), [BACK, EXIT]);

    for (const inner of entry.menu.entries) {
      assert.ok(!ids.has(inner.id), `duplicate id ${inner.id}`);
      ids.add(inner.id);
    }
  }
});

test('runMenu prints the banner, lists MCP servers and comes back to the menu', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { ctx, output } = createCtx();
  const { io, screens, logs } = scriptedIo([
    'mcp',
    'mcp-list',
    BACK,
    'maintenance',
    'doctor-global',
    EXIT,
  ]);

  const code = await runMenu(ctx, { banner: 'BANNER', io });

  assert.equal(code, 0);
  assert.match(output(), /^BANNER\n/);
  assert.match(output(), /context7/);
  assert.deepEqual(
    screens.map((screen) => screen.message),
    [
      'What do you want to do?',
      'MCP servers',
      'MCP servers',
      'What do you want to do?',
      'Sync and health checks',
      'Sync and health checks',
    ],
  );
  assert.equal(logs[0], 'intro: Main menu');
  assert.equal(logs.at(-1), 'outro: See you next time.');
});
