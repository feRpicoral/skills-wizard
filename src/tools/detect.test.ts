import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, tempPaths } from '../test-support/fixtures.ts';
import { detectTools } from './detect.ts';

test('detectTools finds tools from their config directories', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.claudeHome, { recursive: true });

  const detected = await detectTools(paths, []);

  assert.ok(detected.includes('claude-code'));
  assert.ok(!detected.includes('codex'));
});

test('detectTools finds tools from executables on the search path', async (t) => {
  const paths = await tempPaths(t);
  const bin = await tempDir(t);
  await writeFile(join(bin, 'codex'), '#!/bin/sh\n');
  await chmod(join(bin, 'codex'), 0o755);

  const detected = await detectTools(paths, [bin]);

  assert.ok(detected.includes('codex'));
});
