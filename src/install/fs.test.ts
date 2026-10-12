import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { UnsafeWriteError } from '../errors.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { fsErrorReason, realLocation, writeTextAtomic } from './fs.ts';

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
    UnsafeWriteError,
  );
});

test('writeTextAtomic leaves no temporary file behind when it fails', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, { 'target/keep.md': 'keep\n' });

  await assert.rejects(writeTextAtomic(join(dir, 'target'), 'new\n'));

  assert.deepEqual(await readdir(dir), ['target']);
});

test('realLocation resolves linked parent directories of a missing file', async (t) => {
  const dir = await realpath(await tempDir(t));
  await mkdir(join(dir, 'elsewhere'));
  await symlink(join(dir, 'elsewhere'), join(dir, 'linked'));

  const location = await realLocation(join(dir, 'linked', 'new', 'file.md'));

  assert.equal(location, join(dir, 'elsewhere', 'new', 'file.md'));
});

test('realLocation follows a symlinked file to its target', async (t) => {
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'real.md': 'real\n' });
  await symlink('real.md', join(dir, 'link.md'));

  const location = await realLocation(join(dir, 'link.md'));

  assert.equal(location, join(dir, 'real.md'));
});

test('realLocation returns null when a link on the path is dangling', async (t) => {
  const dir = await realpath(await tempDir(t));
  await symlink(join(dir, 'missing'), join(dir, 'linked'));

  const location = await realLocation(join(dir, 'linked', 'file.md'));

  assert.equal(location, null);
});

test('fsErrorReason describes the errors planning turns into conflicts', async (t) => {
  const dir = await tempDir(t);

  const error = await readFile(dir).catch((caught: unknown) => caught);

  assert.equal(fsErrorReason(error), 'is a directory');
  assert.equal(fsErrorReason(new Error('plain')), undefined);
});
