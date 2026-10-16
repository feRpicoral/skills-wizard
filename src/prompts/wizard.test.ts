import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CancelledError } from '../errors.ts';
import { runWizard, wizardStep } from './wizard.ts';

type Reply<T> = T | 'esc';

/** A scripted prompt: each call takes the next reply, `'esc'` cancels it. */
function scripted() {
  let answered = 0;
  const log: string[] = [];

  return {
    log,
    answered: () => answered,
    async ask<T>(name: string, initial: T, replies: Reply<T>[]): Promise<T> {
      await Promise.resolve();
      const reply = replies.shift();
      log.push(`${name}:${JSON.stringify(initial)}`);

      if (reply === undefined) throw new Error(`no reply left for ${name}`);
      if (reply === 'esc') throw new CancelledError('Cancelled');

      answered += 1;

      return reply;
    },
  };
}

test('runWizard goes back to the previous question with its answer kept', async () => {
  const prompt = scripted();
  const presetReplies: Reply<string>[] = ['nx', 'nx'];
  const blockReplies: Reply<string[]>[] = [
    ['a', 'b'],
    ['a', 'b'],
  ];
  const skillReplies: Reply<string[]>[] = ['esc', ['s']];
  let skills: string[] = [];

  await runWizard(
    [
      wizardStep<string>(
        async (remembered) =>
          await prompt.ask('preset', remembered ?? 'none', presetReplies),
      ),
      wizardStep<undefined>(() => Promise.resolve(undefined)),
      wizardStep<string[]>(
        async (remembered) =>
          await prompt.ask('blocks', remembered ?? ['default'], blockReplies),
      ),
      wizardStep<string[]>(async (remembered) => {
        skills = await prompt.ask('skills', remembered ?? ['x'], skillReplies);

        return skills;
      }),
    ],
    { answered: prompt.answered },
  );

  assert.deepEqual(prompt.log, [
    'preset:"none"',
    'blocks:["default"]',
    'skills:["x"]',
    'blocks:["a","b"]',
    'skills:["x"]',
  ]);
  assert.deepEqual(skills, ['s']);
});

test('runWizard skips steps that asked nothing and recomputes answers after an earlier change', async () => {
  const prompt = scripted();
  const presetReplies: Reply<string>[] = ['nx', 'vite'];
  const blockReplies: Reply<string[]>[] = [['a'], 'esc', ['c']];
  const skillReplies: Reply<string[]>[] = ['esc', ['s']];

  await runWizard(
    [
      wizardStep<string>(
        async (remembered) =>
          await prompt.ask('preset', remembered ?? 'none', presetReplies),
      ),
      wizardStep<undefined>(() => Promise.resolve(undefined)),
      wizardStep<string[]>(
        async (remembered) =>
          await prompt.ask('blocks', remembered ?? ['default'], blockReplies),
      ),
      wizardStep<string[]>(
        async (remembered) =>
          await prompt.ask('skills', remembered ?? ['x'], skillReplies),
      ),
    ],
    { answered: prompt.answered },
  );

  assert.deepEqual(prompt.log, [
    'preset:"none"',
    'blocks:["default"]',
    'skills:["x"]',
    'blocks:["a"]',
    'preset:"nx"',
    'blocks:["default"]',
    'skills:["x"]',
  ]);
});

test('runWizard throws when the first question is cancelled', async () => {
  const prompt = scripted();

  await assert.rejects(
    runWizard(
      [
        wizardStep<undefined>(() => Promise.resolve(undefined)),
        wizardStep<string>(async () => await prompt.ask('dir', '.', ['esc'])),
      ],
      { answered: prompt.answered },
    ),
    CancelledError,
  );
});

test('runWizard runs a step again when a later prompt in it is cancelled', async () => {
  const prompt = scripted();
  const replies: Reply<string>[] = ['one', 'esc', 'one', 'two'];
  const log: string[][] = [];

  await runWizard(
    [
      wizardStep<string[]>(async () => {
        const first = await prompt.ask('first', '', replies);
        const second = await prompt.ask('second', '', replies);
        log.push([first, second]);

        return [first, second];
      }),
    ],
    { answered: prompt.answered },
  );

  assert.deepEqual(log, [['one', 'two']]);
});

test('runWizard passes through errors other than cancellation', async () => {
  await assert.rejects(
    runWizard([wizardStep<undefined>(() => Promise.reject(new Error('boom')))]),
    /boom/,
  );
});
