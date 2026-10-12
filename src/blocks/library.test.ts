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
import { loadBlockLibrary } from './library.ts';

const repoBlocks = join(import.meta.dirname, '..', '..', 'blocks');

test('loads the repository block library in index order', async () => {
  const library = await loadBlockLibrary(repoBlocks);

  assert.equal(library.blocks.length, 24);
  assert.equal(library.blocks[0]?.id, 'core/identity');
  assert.deepEqual(library.blocks[0]?.variables, ['githubUsername']);
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
