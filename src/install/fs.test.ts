import assert from 'node:assert/strict';
import { chmod, readdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { writeTextAtomic } from './fs.ts';

test('writeTextAtomic keeps the mode of the file it replaces', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'settings.json');
  await writeFiles(dir, { 'settings.json': '{}\n' });
  await chmod(file, 0o600);

  await writeTextAtomic(file, '{"a":1}\n');

  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
});

test('writeTextAtomic refuses to replace a symlink', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, { 'real.md': 'real\n' });
  await symlink(join(dir, 'real.md'), join(dir, 'link.md'));

  await assert.rejects(
    writeTextAtomic(join(dir, 'link.md'), 'new\n'),
    /symlink/,
  );
});

test('writeTextAtomic leaves no temporary file behind when it fails', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, { 'target/keep.md': 'keep\n' });

  await assert.rejects(writeTextAtomic(join(dir, 'target'), 'new\n'));

  assert.deepEqual(await readdir(dir), ['target']);
});
