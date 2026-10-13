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
  escapingLinks,
  hashInstalledCopy,
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

test('copySkillTree leaves out generated Python output', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, {
    'SKILL.md': 'skill\n',
    'scripts/run.py': 'print()\n',
    'scripts/run.pyc': 'compiled\n',
    'scripts/__pycache__/run.cpython-312.pyc': 'compiled\n',
    '.pytest_cache/README.md': 'cache\n',
    '.venv/bin/python': 'python\n',
  });

  await copySkillTree({ source, destination: join(root, 'copy') });

  assert.deepEqual(await listFiles(join(root, 'copy')), [
    'SKILL.md',
    'scripts/run.py',
  ]);
});

test('escapingLinks reports absolute links and links that leave the skill', async (t) => {
  const root = await tempDir(t);
  const skill = join(root, 'skill');
  await writeFiles(skill, {
    'SKILL.md': 'skill\n',
    'docs/guide.md': 'g\n',
    'references/notes.md': 'n\n',
  });
  await symlink('/etc/hosts', join(skill, 'hosts'));
  await symlink('../../../.ssh/id_rsa', join(skill, 'docs', 'key'));
  await symlink('../shared', join(skill, 'shared'));
  await symlink('../docs/guide.md', join(skill, 'references', 'guide.md'));
  await symlink('docs', join(skill, 'manual'));
  await symlink('/etc/passwd', join(skill, 'AGENTS.md'));

  assert.deepEqual(await escapingLinks(skill), [
    { path: 'docs/key', target: '../../../.ssh/id_rsa' },
    { path: 'hosts', target: '/etc/hosts' },
    { path: 'shared', target: '../shared' },
  ]);
});

test('copySkillTree refuses links that leave the skill', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, { 'SKILL.md': 'skill\n' });
  await symlink('../outside.md', join(source, 'outside.md'));

  await assert.rejects(
    copySkillTree({ source, destination: join(root, 'copy') }),
    /outside\.md: it links outside the skill/,
  );
});

test('copySkillTree refuses absolute links', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, { 'SKILL.md': 'skill\n' });
  await symlink('/etc/hosts', join(source, 'hosts'));

  await assert.rejects(
    copySkillTree({ source, destination: join(root, 'copy') }),
    /hosts: it links outside the skill \(\/etc\/hosts\)/,
  );
});

test('hashInstalledCopy of a pristine copy equals the source hash', async (t) => {
  const root = await tempDir(t);
  const source = join(root, 'source');
  await writeFiles(source, {
    'SKILL.md': 'skill\n',
    'AGENTS.md': 'repo rules\n',
    'evals/evals.json': '{}\n',
    'node_modules/dep/index.js': 'x\n',
    'scripts/run.sh': 'echo\n',
  });
  await symlink('scripts/run.sh', join(source, 'run.sh'));
  const copy = join(root, 'copy');
  await copySkillTree({ source, destination: copy });

  const [recorded, installed] = await Promise.all([
    hashTree(source),
    hashInstalledCopy({ dir: copy, setup: false }),
  ]);

  assert.equal(installed, recorded);
});

test('hashInstalledCopy sees files the copy leaves out', async (t) => {
  const root = await tempDir(t);
  const pristine = join(root, 'pristine');
  await writeFiles(pristine, { 'SKILL.md': 'skill\n' });
  const recorded = await hashTree(pristine);

  for (const extra of [
    'evals/mine.json',
    'references/AGENTS.md',
    '.git/HEAD',
    'node_modules/dep/index.js',
  ]) {
    const dir = join(root, extra.replaceAll('/', '-'));
    await writeFiles(dir, { 'SKILL.md': 'skill\n', [extra]: 'mine\n' });
    assert.notEqual(
      await hashInstalledCopy({ dir, setup: false }),
      recorded,
      extra,
    );
  }
});

test('hashInstalledCopy ignores generated output and setup output only with setup', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, { 'SKILL.md': 'skill\n', 'scripts/run.py': 'p\n' });
  const recorded = await hashTree(root);
  await writeFiles(root, {
    '.DS_Store': 'x',
    'scripts/__pycache__/run.cpython-312.pyc': 'compiled\n',
    'scripts/run.pyc': 'compiled\n',
    '.pytest_cache/README.md': 'cache\n',
  });
  const scriptsRun = await hashInstalledCopy({ dir: root, setup: false });
  await writeFiles(root, {
    'node_modules/dep/index.js': 'x\n',
    '.venv/bin/python': 'python\n',
  });

  const [withSetup, withoutSetup] = await Promise.all([
    hashInstalledCopy({ dir: root, setup: true }),
    hashInstalledCopy({ dir: root, setup: false }),
  ]);

  assert.equal(scriptsRun, recorded);
  assert.equal(withSetup, recorded);
  assert.notEqual(withoutSetup, recorded);
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
