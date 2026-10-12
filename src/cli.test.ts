import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { tempDir } from './test-support/fixtures.ts';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, 'cli.ts');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(home: string, args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { HOME: home, PATH: process.env.PATH ?? '' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return {
      code: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
}

const INSTALL = [
  'init',
  '--global',
  '--yes',
  '--tools',
  'codex',
  '--var',
  'githubUsername=octocat',
];

test('init --dry-run prints the plan and writes nothing', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, [...INSTALL, '--dry-run']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /create\s+~\/\.codex\/AGENTS\.md/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init installs and doctor then finds no problems', async (t) => {
  const home = await tempDir(t);

  const install = await cli(home, INSTALL);
  const doctor = await cli(home, ['doctor']);

  assert.equal(install.code, 0);
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /No problems found/);
});

test('sync reapplies a recorded install after a file was edited', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'edited\n');

  const doctor = await cli(home, ['doctor']);
  const sync = await cli(home, ['sync', '--yes']);

  assert.match(doctor.stdout, /out of date/);
  assert.equal(sync.code, 0);
  assert.match(sync.stdout, /update\s+~\/\.codex\/AGENTS\.md/);
});

test('rejects unknown tools with a usage error', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, [
    'init',
    '--global',
    '--yes',
    '--tools',
    'nope',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown tools: nope/);
});

test('sync without a recorded install is a usage error', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, ['sync', '--yes']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /run agents-config init first/);
});
