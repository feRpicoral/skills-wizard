import assert from 'node:assert/strict';
import { readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempSearchPath } from './fixtures.ts';

test('tempSearchPath links node to the running binary', async (t) => {
  const dir = await tempSearchPath(t, ['node']);

  assert.equal(await readlink(join(dir, 'node')), process.execPath);
});
