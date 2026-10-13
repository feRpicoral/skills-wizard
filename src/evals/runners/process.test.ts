import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { RunnerError } from '../../errors.ts';
import { tempDir, writeFiles } from '../../test-support/fixtures.ts';
import { checkRunnerBinary, spawnRunnerProcess } from './types.ts';

const SYSTEM_PATH = '/usr/bin:/bin';

async function stubBinary(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  await writeFiles(dir, { [name]: body });
  const path = join(dir, name);
  await chmod(path, 0o755);
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const text = await readFile(path, 'utf8').catch(() => '');
    const pid = Number.parseInt(text.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await delay(20);
  }
  throw new Error(`no pid in ${path}`);
}

async function waitUntilDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!isAlive(pid)) return true;
    await delay(20);
  }
  return false;
}

test(
  'spawnRunnerProcess kills the whole process group on timeout, even when the child ignores SIGTERM',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await tempDir(t);
    const pidFile = join(root, 'grandchild.pid');
    // The child ignores SIGTERM and leaves a grandchild that holds stdout.
    const binary = await stubBinary(
      root,
      'stubborn',
      [
        '#!/bin/sh',
        "trap '' TERM",
        'sleep 30 &',
        `echo $! > "${pidFile}"`,
        'echo started',
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await spawnRunnerProcess({
      binary,
      args: [],
      cwd: root,
      runDir: join(root, 'run'),
      timeoutSeconds: 0.3,
      env: { PATH: SYSTEM_PATH },
      killGraceMs: 100,
      drainMs: 100,
    });
    const elapsed = Date.now() - started;
    const grandchild = await readPid(pidFile);

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 124);
    assert.match(result.stdout, /started/);
    assert.ok(elapsed < 5_000, `settled after ${elapsed}ms`);
    assert.equal(await waitUntilDead(grandchild), true);
  },
);

test(
  'spawnRunnerProcess settles after the drain deadline when a descendant keeps stdout open',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await tempDir(t);
    const pidFile = join(root, 'grandchild.pid');
    const binary = await stubBinary(
      root,
      'leaky',
      [
        '#!/bin/sh',
        'sleep 30 &',
        `echo $! > "${pidFile}"`,
        'echo done',
        'exit 3',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await spawnRunnerProcess({
      binary,
      args: [],
      cwd: root,
      runDir: join(root, 'run'),
      timeoutSeconds: 20,
      env: { PATH: SYSTEM_PATH },
      drainMs: 100,
    });
    const elapsed = Date.now() - started;
    const grandchild = await readPid(pidFile);

    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /done/);
    assert.ok(elapsed < 5_000, `settled after ${elapsed}ms`);
    assert.equal(await waitUntilDead(grandchild), true);
  },
);

test('spawnRunnerProcess passes only the given environment to the child', async (t) => {
  const root = await tempDir(t);
  const binary = await stubBinary(root, 'printenv', '#!/bin/sh\nenv\n');

  const result = await spawnRunnerProcess({
    binary,
    args: [],
    cwd: root,
    runDir: join(root, 'run'),
    timeoutSeconds: 10,
    env: { PATH: SYSTEM_PATH, EVAL_MARKER: 'yes' },
  });

  assert.match(result.stdout, /^EVAL_MARKER=yes$/m);
  assert.doesNotMatch(result.stdout, /^HOME=/m);
  assert.equal(
    await readFile(join(root, 'run', 'stdout.log'), 'utf8'),
    result.stdout,
  );
});

test('spawnRunnerProcess rejects with RunnerError when the binary is missing', async (t) => {
  const root = await tempDir(t);
  await assert.rejects(
    spawnRunnerProcess({
      binary: join(root, 'missing'),
      args: [],
      cwd: root,
      runDir: join(root, 'run'),
      timeoutSeconds: 10,
      env: { PATH: SYSTEM_PATH },
    }),
    RunnerError,
  );
});

test('checkRunnerBinary resolves commands on the given PATH and rejects missing or non-executable binaries', async (t) => {
  const root = await tempDir(t);
  const binDir = join(root, 'bin');
  const executable = await stubBinary(binDir, 'tool', '#!/bin/sh\nexit 0\n');
  await writeFiles(binDir, { 'not-exec': '#!/bin/sh\nexit 0\n' });

  assert.equal(
    await checkRunnerBinary({ binary: 'tool', env: { PATH: binDir } }),
    executable,
  );
  assert.equal(
    await checkRunnerBinary({ binary: executable, env: {} }),
    executable,
  );
  await assert.rejects(
    checkRunnerBinary({ binary: 'tool', env: { PATH: join(root, 'empty') } }),
    RunnerError,
  );
  await assert.rejects(
    checkRunnerBinary({ binary: 'tool', env: {} }),
    RunnerError,
  );
  await assert.rejects(
    checkRunnerBinary({ binary: join(binDir, 'not-exec'), env: {} }),
    RunnerError,
  );
  await assert.rejects(
    checkRunnerBinary({ binary: binDir, env: {} }),
    RunnerError,
  );
  await assert.rejects(
    checkRunnerBinary({ binary: 'bin/tool', env: { PATH: binDir } }),
    /absolute path/,
  );
});
