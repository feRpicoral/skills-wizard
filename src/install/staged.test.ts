import assert from 'node:assert/strict';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { readStaged, stageAction, type StagedContents } from './staged.ts';

test('staging a link deletion leaves the file it points to in place', async (t) => {
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'cli.ts': 'run\n' });
  await symlink(join(dir, 'cli.ts'), join(dir, 'skills-wizard'));
  const staged: StagedContents = new Map();
  await stageAction({
    staged,
    action: {
      path: join(dir, 'skills-wizard'),
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

test('removing a skill folder or its link stages nothing under the skill folder', async (t) => {
  const dir = await realpath(await tempDir(t));
  const folder = join(dir, '.agents', 'skills', 'notes');
  const link = join(dir, '.claude', 'skills', 'notes');
  await writeFiles(dir, {
    '.agents/skills/notes/SKILL.md': 'notes\n',
    '.claude/skills/.keep': '',
  });
  await symlink(folder, link);
  const staged: StagedContents = new Map();
  const skill = {
    kind: 'skill',
    path: folder,
    name: 'notes',
    source: { type: 'local', path: 'skills/notes' },
    install: { mode: 'copy', hash: 'sha256:0' },
  } as const;

  await stageAction({
    staged,
    action: {
      path: link,
      label: 'no longer selected',
      status: 'remove',
      change: { type: 'delete' },
      entry: null,
      previous: { kind: 'symlink', path: link, target: folder },
    },
  });
  await stageAction({
    staged,
    action: {
      path: folder,
      label: 'no longer selected',
      status: 'remove',
      change: { type: 'delete-tree' },
      entry: null,
      previous: skill,
    },
  });

  assert.deepEqual([...staged.keys()], [link]);
  const { current } = await readStaged({
    staged,
    path: join(folder, 'SKILL.md'),
  });
  assert.equal(current, 'notes\n');
});
