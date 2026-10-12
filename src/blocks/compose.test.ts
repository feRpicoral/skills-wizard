import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompositionError } from '../errors.ts';
import {
  composeGlobal,
  composeProject,
  defaultBlockIds,
  renderBlocks,
  selectBlocks,
  withRequirements,
} from './compose.ts';
import type { Block, BlockLibrary } from './library.ts';

function block(id: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    group: id.split('/')[0] ?? 'core',
    title: id,
    summary: id,
    scopes: ['global', 'project'],
    defaults: ['global'],
    variables: [],
    requires: [],
    body: `## ${id}`,
    ...overrides,
  };
}

const library: BlockLibrary = {
  headers: { global: '# Rules' },
  groups: { core: 'Core', git: 'Git' },
  blocks: [
    block('core/identity', {
      scopes: ['global'],
      variables: ['githubUsername'],
      body: 'GitHub username: {{githubUsername}}',
    }),
    block('core/style', { defaults: ['global', 'project'] }),
    block('git/commits'),
    block('git/descriptions', { requires: ['core/style'] }),
  ],
};

test('selectBlocks keeps index order regardless of requested order', () => {
  const selected = selectBlocks(
    library,
    ['git/commits', 'core/style'],
    'project',
  );

  assert.deepEqual(
    selected.map((entry) => entry.id),
    ['core/style', 'git/commits'],
  );
});

test('selectBlocks rejects blocks outside the requested scope', () => {
  assert.throws(
    () => selectBlocks(library, ['core/identity'], 'project'),
    /not available for project scope: core\/identity/,
  );
});

test('selectBlocks rejects unknown block ids', () => {
  assert.throws(
    () => selectBlocks(library, ['core/missing'], 'global'),
    CompositionError,
  );
});

test('defaultBlockIds returns the blocks that default to a scope', () => {
  const ids = defaultBlockIds(library, 'project');

  assert.deepEqual(ids, ['core/style']);
});

test('renderBlocks substitutes variables and joins bodies with a blank line', () => {
  const rendered = renderBlocks(
    selectBlocks(library, ['core/identity', 'core/style'], 'global'),
    { githubUsername: 'octocat' },
  );

  assert.equal(rendered, 'GitHub username: octocat\n\n## core/style');
});

test('renderBlocks fails when a required variable is missing or blank', () => {
  const blocks = selectBlocks(library, ['core/identity'], 'global');

  assert.throws(
    () => renderBlocks(blocks, { githubUsername: ' ' }),
    /Missing variables: githubUsername/,
  );
});

test('composeGlobal prefixes the header and ends with a newline', () => {
  const composed = composeGlobal(library, ['core/identity'], {
    githubUsername: 'octocat',
  });

  assert.equal(composed, '# Rules\n\nGitHub username: octocat\n');
});

test('composeProject renders only the block bodies', () => {
  const composed = composeProject(library, ['git/commits'], {});

  assert.equal(composed, '## git/commits\n');
});

test('selectBlocks rejects a block whose requirement is not selected', () => {
  assert.throws(
    () => selectBlocks(library, ['git/descriptions'], 'global'),
    /git\/descriptions requires core\/style/,
  );
});

test('withRequirements adds missing requirements in index order', () => {
  const result = withRequirements(library, ['git/descriptions']);

  assert.deepEqual(result, {
    ids: ['core/style', 'git/descriptions'],
    added: ['core/style'],
  });
});
