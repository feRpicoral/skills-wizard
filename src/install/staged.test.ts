import assert from 'node:assert/strict';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import type { PlannedAction } from './safety.ts';
import { readStaged, stageAction, type StagedContents } from './staged.ts';

test('a removed link leaves the file it points to readable for later actions', async (t) => {
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': 'shared\n' });
  const link = join(dir, 'CLAUDE.md');
  await symlink(join(dir, 'AGENTS.md'), link);
  const staged: StagedContents = new Map();
  const action: PlannedAction = {
    path: link,
    label: 'remove',
    status: 'remove',
    change: { type: 'delete' },
    entry: null,
    previous: { kind: 'symlink', path: link, target: join(dir, 'AGENTS.md') },
  };

  await stageAction({ staged, action });

  assert.equal(staged.size, 0);
  const { current } = await readStaged({
    staged,
    path: join(dir, 'AGENTS.md'),
  });
  assert.equal(current, 'shared\n');
});

test('a deleted text file reads as gone for later actions', async (t) => {
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': 'mine\n' });
  const path = join(dir, 'AGENTS.md');
  const staged: StagedContents = new Map();
  const action: PlannedAction = {
    path,
    label: 'remove',
    status: 'remove',
    change: { type: 'delete' },
    entry: null,
    previous: { kind: 'region', path, createdFile: true },
  };

  await stageAction({ staged, action });

  assert.equal((await readStaged({ staged, path })).current, null);
});
