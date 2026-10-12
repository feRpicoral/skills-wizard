import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  copySkillTree,
  hashTree,
  replaceWithCopy,
  replaceWithLink,
} from './tree.ts';

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

test('copySkillTree leaves out repository, dependency, eval and instruction files', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, {
    'SKILL.md': 'skill\n',
    'AGENTS.md': 'repo rules\n',
    '.git/config': '[core]\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'node_modules/dep/index.js': 'x\n',
    'evals/evals.json': '{}\n',
    'references/evals/notes.md': 'kept\n',
    'references/CLAUDE.md': 'nested rules\n',
    'scripts/run.sh': '#!/bin/sh\n',
  });
  await chmod(join(source, 'scripts', 'run.sh'), 0o755);

  await copySkillTree({ source, destination: join(root, 'copy') });

  assert.deepEqual(await listFiles(join(root, 'copy')), [
    'SKILL.md',
    'references/evals/notes.md',
    'scripts/run.sh',
  ]);
  assert.equal(
    (await stat(join(root, 'copy', 'scripts', 'run.sh'))).mode & 0o777,
    0o755,
  );
});

test('copySkillTree keeps links as links', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, { 'SKILL.md': 'skill\n', 'docs/guide.md': 'g\n' });
  await symlink('docs/guide.md', join(source, 'guide.md'));

  await copySkillTree({ source, destination: join(root, 'copy') });

  assert.equal(await readlink(join(root, 'copy', 'guide.md')), 'docs/guide.md');
});

test('hashTree matches between a source and its copy', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, {
    'SKILL.md': 'skill\n',
    '.git/HEAD': 'ref\n',
    'scripts/run.sh': 'echo\n',
  });
  await copySkillTree({ source, destination: join(root, 'copy') });

  const [original, copied] = await Promise.all([
    hashTree(source),
    hashTree(join(root, 'copy')),
  ]);

  assert.equal(copied, original);
});

test('hashTree changes when a file changes', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, { 'SKILL.md': 'skill\n' });
  const before = await hashTree(root);
  await writeFiles(root, { 'SKILL.md': 'edited\n' });

  const after = await hashTree(root);

  assert.notEqual(after, before);
});

test('hashTree changes when a file becomes executable', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, { 'SKILL.md': 'skill\n', 'run.sh': 'echo\n' });
  const before = await hashTree(root);
  await chmod(join(root, 'run.sh'), 0o755);

  const after = await hashTree(root);

  assert.notEqual(after, before);
});

test('replaceWithCopy swaps in the new tree and leaves no staging files', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'source/SKILL.md': 'new\n',
    'skills/demo/SKILL.md': 'old\n',
    'skills/demo/stale.md': 'stale\n',
  });

  await replaceWithCopy({
    source: join(root, 'source'),
    destination: join(root, 'skills', 'demo'),
  });

  assert.deepEqual(await readdir(join(root, 'skills')), ['demo']);
  assert.deepEqual(await listFiles(join(root, 'skills', 'demo')), ['SKILL.md']);
  assert.equal(
    await readFile(join(root, 'skills', 'demo', 'SKILL.md'), 'utf8'),
    'new\n',
  );
});

test('replaceWithCopy moves what it replaces into the backup', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'source/SKILL.md': 'new\n',
    'skills/demo/SKILL.md': 'mine\n',
  });
  const backup = join(root, 'backups', 'skills', 'demo');

  await replaceWithCopy({
    source: join(root, 'source'),
    destination: join(root, 'skills', 'demo'),
    backup,
  });

  assert.equal(await readFile(join(backup, 'SKILL.md'), 'utf8'), 'mine\n');
});

test('replaceWithLink replaces a directory with a link', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, { 'skills/demo/SKILL.md': 'copy\n' });

  await replaceWithLink({
    target: '/repo/skills/demo',
    destination: join(root, 'skills', 'demo'),
  });

  assert.ok((await lstat(join(root, 'skills', 'demo'))).isSymbolicLink());
  assert.deepEqual(await readdir(join(root, 'skills')), ['demo']);
});
