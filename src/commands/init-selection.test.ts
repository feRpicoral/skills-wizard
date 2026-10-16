import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadBlockLibrary } from '../blocks/library.ts';
import { blockSkillNames, loadSkillLibrary } from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import { commandSandbox } from '../test-support/command-fixtures.ts';
import { resolveSkillsSelection } from './init-selection.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

async function libraries() {
  return {
    library: await loadBlockLibrary(join(REPO_ROOT, 'blocks')),
    skillLibrary: await loadSkillLibrary(REPO_ROOT),
  };
}

function recorded(blocks: string[], skills: string[]): Manifest {
  return { blocks, skills, options: {} } as unknown as Manifest;
}

test('every skill a block suggests exists for each of the block scopes', async () => {
  const { library, skillLibrary } = await libraries();

  for (const block of library.blocks) {
    for (const scope of block.scopes) {
      assert.deepEqual(
        blockSkillNames({
          library: skillLibrary,
          blocks: library,
          blockIds: [block.id],
          scope,
        }),
        [...new Set(block.skills)],
        `${block.id} suggests skills that are unknown or not available for ${scope} scope`,
      );
    }
  }
});

test('a first project run preselects the skills of every selected block', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { library, skillLibrary } = await libraries();

  const skills = await resolveSkillsSelection({
    ctx: createCtx().ctx,
    library,
    skillLibrary,
    scope: 'project',
    blocks: ['stack/lint-format', 'stack/nx', 'stack/nestjs', 'stack/prisma'],
    prompting: false,
    presetChanged: false,
    presetSelection: {
      blocks: [],
      skills: ['eslint-configuration', 'prettier-configuration'],
    },
    previous: null,
  });

  assert.deepEqual(skills, [
    'eslint-configuration',
    'prettier-configuration',
    'nestjs-module',
    'prisma-cli',
    'prisma-client-api',
    'prisma-orm-setup',
    'prisma-upgrade-v7',
  ]);
});

test('a re-run adds only the skills of newly selected blocks', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { library, skillLibrary } = await libraries();

  const skills = await resolveSkillsSelection({
    ctx: createCtx().ctx,
    library,
    skillLibrary,
    scope: 'project',
    blocks: ['stack/nestjs', 'stack/tanstack-query'],
    prompting: false,
    presetChanged: false,
    presetSelection: null,
    previous: recorded(['stack/nestjs'], ['prisma-cli']),
  });

  assert.deepEqual(skills, ['prisma-cli', 'tanstack-query-expert']);
});

test('explicit --skills are kept as given', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { library, skillLibrary } = await libraries();

  const skills = await resolveSkillsSelection({
    ctx: createCtx().ctx,
    library,
    skillLibrary,
    scope: 'project',
    blocks: ['stack/nestjs'],
    prompting: false,
    requestedSkills: [],
    presetChanged: false,
    presetSelection: null,
    previous: null,
  });

  assert.deepEqual(skills, []);
});

test('a re-run drops the skills of blocks that are no longer selected', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { library, skillLibrary } = await libraries();

  const skills = await resolveSkillsSelection({
    ctx: createCtx().ctx,
    library,
    skillLibrary,
    scope: 'project',
    blocks: ['stack/react-vite'],
    prompting: false,
    presetChanged: false,
    presetSelection: null,
    previous: recorded(
      ['stack/nextjs', 'stack/react-vite'],
      [
        'skill-author',
        'vercel-react-best-practices',
        'vercel-composition-patterns',
      ],
    ),
  });

  assert.deepEqual(skills, ['skill-author', 'vercel-react-best-practices']);
});
