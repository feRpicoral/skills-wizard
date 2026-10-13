import assert from 'node:assert/strict';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { readStaged, stageAction, type StagedContents } from './staged.ts';

test('staging a link deletion leaves the file it points to in place', async (t) => {
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'cli.ts': 'run\n' });
  await symlink(join(dir, 'cli.ts'), join(dir, 'agents-config'));
  const staged: StagedContents = new Map();
  await stageAction({
    staged,
    action: {
      path: join(dir, 'agents-config'),
      label: 'no longer selected',
      status: 'remove',
      change: { type: 'delete' },
      entry: null,
      previous: null,
    },
  });

  const { current } = await readStaged({ staged, path: join(dir, 'cli.ts') });

  assert.equal(current, 'run\n');
});

test('staging a file deletion makes later reads see it gone', async (t) => {
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': 'rules\n' });
  const staged: StagedContents = new Map();
  await stageAction({
    staged,
    action: {
      path: join(dir, 'AGENTS.md'),
      label: 'no longer selected',
      status: 'remove',
      change: { type: 'delete' },
      entry: null,
      previous: null,
    },
  });

  const { current } = await readStaged({
    staged,
    path: join(dir, 'AGENTS.md'),
  });

  assert.equal(current, null);
});
