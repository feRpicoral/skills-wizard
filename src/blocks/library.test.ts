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

test('loads the repository block library starting with the identity block', async () => {
  const library = await loadBlockLibrary(repoBlocks);

  assert.equal(library.blocks[0]?.id, 'core/identity');
  assert.deepEqual(library.blocks[0]?.variables, ['githubUsername']);
});

test('repository blocks require every section they refer to', async () => {
  const library = await loadBlockLibrary(repoBlocks);
  const headings = new Map(
    library.blocks.map((block) => [block.body.match(/^## (.+)$/m)?.[1], block.id]),
  );

  for (const block of library.blocks) {
    for (const [, heading] of block.body.matchAll(/see "([^"]+)"/g)) {
      const referenced = headings.get(heading);
      assert.ok(referenced, `${block.id} refers to an unknown section ${heading}`);
      assert.ok(
        block.requires.includes(referenced),
        `${block.id} refers to "${heading}" without requiring ${referenced}`,
      );
    }
  }
  const gitBehavior = library.blocks.find((block) => block.id === 'git/git-behavior');
  assert.match(gitBehavior?.body ?? '', /the comment policy/);
  assert.deepEqual(gitBehavior?.requires, ['engineering/comments']);
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

test('rejects an index that is not valid YAML, naming the index file', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, { 'index.yaml': 'order: [core/one\n' });

  await assert.rejects(loadBlockLibrary(dir), (error) => {
    assert.ok(error instanceof BlockLibraryError);
    assert.match(error.message, /index\.yaml: invalid YAML/);
    return true;
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
