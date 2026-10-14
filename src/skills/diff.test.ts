import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { skillSource, tempDir, writeFiles } from '../test-support/fixtures.ts';
import { changedFiles, diffSkillTrees, hasDiff } from './diff.ts';

test('diffSkillTrees lists added, modified and removed files', async (t) => {
  const before = await tempDir(t);
  const after = await tempDir(t);
  await writeFiles(before, {
    'SKILL.md': skillSource('alpha'),
    'references/old.md': 'old\n',
    'references/kept.md': 'same\n',
  });
  await writeFiles(after, {
    'SKILL.md': `${skillSource('alpha')}\nUpdated.\n`,
    'references/new.md': 'new\n',
    'references/kept.md': 'same\n',
  });

  const diff = await diffSkillTrees({ previousDir: before, nextDir: after });

  assert.equal(hasDiff(diff), true);
  assert.deepEqual(diff.added, ['references/new.md']);
  assert.deepEqual(diff.modified, ['SKILL.md']);
  assert.deepEqual(diff.removed, ['references/old.md']);
  assert.deepEqual(changedFiles(diff), ['SKILL.md', 'references/new.md']);
});

test('diffSkillTrees detects permission changes on existing files', async (t) => {
  const before = await tempDir(t);
  const after = await tempDir(t);
  await writeFiles(before, { 'scripts/run.sh': '#!/bin/sh\necho hi\n' });
  await writeFiles(after, { 'scripts/run.sh': '#!/bin/sh\necho hi\n' });
  await chmod(join(after, 'scripts', 'run.sh'), 0o755);

  const diff = await diffSkillTrees({ previousDir: before, nextDir: after });

  assert.deepEqual(diff.modified, ['scripts/run.sh']);
});
