import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { SetupError } from '../errors.ts';
import { tempDir } from '../test-support/fixtures.ts';
import { runSetup } from './setup.ts';

test('runSetup runs the command inside the skill directory', async (t) => {
  const dir = await tempDir(t);

  await runSetup({ dir, command: 'echo ready > done.txt' });

  assert.equal(await readFile(join(dir, 'done.txt'), 'utf8'), 'ready\n');
});

test('runSetup tolerates more than 1 MiB of output', async (t) => {
  const dir = await tempDir(t);

  await runSetup({
    dir,
    command: 'head -c 3000000 /dev/zero; head -c 3000000 /dev/zero >&2',
  });
});

test('runSetup closes stdin so prompts do not wait for input', async (t) => {
  const dir = await tempDir(t);

  await runSetup({ dir, command: 'cat', timeoutMs: 5_000 });
});

test('a failing setup reports the end of its stderr', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    runSetup({
      dir,
      command:
        "head -c 2000000 /dev/zero | tr '\\0' x >&2; echo >&2; echo 'error: missing tool' >&2; exit 3",
    }),
    (error: unknown) => {
      assert.ok(error instanceof SetupError);
      assert.match(error.message, /failed: error: missing tool$/);
      assert.ok(error.message.length < 1_000);
      return true;
    },
  );
});

test('a failing setup without stderr reports its exit code', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    runSetup({ dir, command: 'exit 4' }),
    /"exit 4" failed: exited with code 4$/,
  );
});

test('a setup that runs too long is stopped', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    runSetup({ dir, command: 'echo working >&2; sleep 30', timeoutMs: 100 }),
    /timed out after 0\.1 seconds/,
  );
});

const BACKGROUND_JOB = 'sleep 30 & echo $! > job.pid; wait';

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail('timed out waiting for the condition');
}

async function jobPid(dir: string): Promise<number> {
  let pid = 0;
  await waitFor(async () => {
    pid = Number.parseInt(
      await readFile(join(dir, 'job.pid'), 'utf8').catch(() => ''),
      10,
    );
    return pid > 0;
  });
  return pid;
}

test('a setup that runs too long is stopped along with its background jobs', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    runSetup({ dir, command: BACKGROUND_JOB, timeoutMs: 300 }),
    /timed out/,
  );

  const pid = await jobPid(dir);
  await waitFor(() => !isRunning(pid));
});

test('an interrupt stops the setup, its background jobs and the CLI', async (t) => {
  const dir = await tempDir(t);
  const setupModule = new URL('./setup.ts', import.meta.url).href;
  const cli = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { runSetup } = await import(${JSON.stringify(setupModule)});
await runSetup({ dir: ${JSON.stringify(dir)}, command: ${JSON.stringify(BACKGROUND_JOB)} });`,
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    cli.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const pid = await jobPid(dir);

  cli.kill('SIGINT');

  assert.deepEqual(await exited, { code: null, signal: 'SIGINT' });
  await waitFor(() => !isRunning(pid));
});
