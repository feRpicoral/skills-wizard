import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { BlockLibraryError, FrontmatterError } from '../errors.ts';
import {
  blockSource,
  indexSource,
  tempDir,
  writeFiles,
} from '../test-support/fixtures.ts';
import { composeGlobal, defaultBlockIds } from './compose.ts';
import { loadBlockLibrary } from './library.ts';

const repoBlocks = join(import.meta.dirname, '..', '..', 'blocks');

test('loads the repository block library starting with the identity block', async () => {
  const library = await loadBlockLibrary(repoBlocks);

  const firstBlock = library.blocks[0];

  assert.equal(firstBlock?.id, 'core/identity');
  assert.deepEqual(firstBlock?.variables, ['githubUsername']);
});

test('repository stack blocks are project-scoped only and global instructions stay at 200 lines', async () => {
  const library = await loadBlockLibrary(repoBlocks);

  const stackBlocks = library.blocks.filter((block) => block.group === 'stack');
  const globalIds = defaultBlockIds(library, 'global');
  const composedGlobal = composeGlobal(library, globalIds, {
    githubUsername: 'feRpicoral',
  });

  assert.equal(stackBlocks.length, 14);
  for (const block of stackBlocks) {
    assert.deepEqual(block.scopes, ['project']);
    assert.deepEqual(block.defaults, []);
  }
  assert.equal(globalIds.includes('git/github-repo-setup'), false);
  assert.equal(globalIds.includes('stack/supabase-prisma'), false);
  assert.equal(
    composedGlobal.split('\n').filter((line) => line.trim().length > 0).length,
    205,
  );
});

test('loads blocks with their frontmatter and trimmed body', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': blockSource('## One\n\nText.\n\n', { group: 'core' }),
  });

  const library = await loadBlockLibrary(dir);

  assert.deepEqual(library.blocks[0], {
    id: 'core/one',
    title: 'Title',
    summary: 'Summary',
    group: 'core',
    scopes: ['global', 'project'],
    defaults: ['global'],
    variables: [],
    requires: [],
    body: '## One\n\nText.',
  });
});

test('rejects block files missing from the index order', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': blockSource('## One', { group: 'core' }),
    'core/two.md': blockSource('## Two', { group: 'core' }),
  });

  await assert.rejects(loadBlockLibrary(dir), BlockLibraryError);
});

test('rejects placeholders that are not declared as variables', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': blockSource('Hello {{name}}', { group: 'core' }),
  });

  await assert.rejects(loadBlockLibrary(dir), /undeclared: name/);
});

test('rejects a group that does not match the directory', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': blockSource('## One', { group: 'git' }),
  });

  await assert.rejects(loadBlockLibrary(dir), /does not match directory/);
});

test('rejects defaults that are outside the block scopes', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': blockSource('## One', {
      group: 'core',
      scopes: ['global'],
      defaults: ['project'],
    }),
  });

  await assert.rejects(loadBlockLibrary(dir), /defaults outside scopes/);
});

test('rejects block files without frontmatter', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': '## One\n',
  });

  await assert.rejects(loadBlockLibrary(dir), FrontmatterError);
});

test('rejects a requirement on an unknown block', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one']),
    'core/one.md': blockSource('## One', {
      group: 'core',
      requires: ['core/missing'],
    }),
  });

  await assert.rejects(loadBlockLibrary(dir), /requires unknown block/);
});

test('rejects a requirement that comes later in the order', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one', 'core/two']),
    'core/one.md': blockSource('## One', {
      group: 'core',
      requires: ['core/two'],
    }),
    'core/two.md': blockSource('## Two', { group: 'core' }),
  });

  await assert.rejects(loadBlockLibrary(dir), /must come before it/);
});

test('rejects a requirement that is missing one of the block scopes', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, {
    'index.yaml': indexSource(['core/one', 'core/two']),
    'core/one.md': blockSource('## One', {
      group: 'core',
      scopes: ['global'],
    }),
    'core/two.md': blockSource('## Two', {
      group: 'core',
      requires: ['core/one'],
    }),
  });

  await assert.rejects(
    loadBlockLibrary(dir),
    /core\/one is not available for project scope/,
  );
});
