import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

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
      assert.match(error.message, /exited with code 3: error: missing tool$/);
      assert.ok(error.message.length < 1_000);
      return true;
    },
  );
});

test('a setup that runs too long is stopped', async (t) => {
  const dir = await tempDir(t);

  await assert.rejects(
    runSetup({ dir, command: 'sleep 30', timeoutMs: 100 }),
    /timed out after 0\.1 seconds/,
  );
});
