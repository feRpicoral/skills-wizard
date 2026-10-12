import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolvePaths } from '../env.ts';
import { tempDir, tempPaths } from '../test-support/fixtures.ts';
import { detectTools } from './detect.ts';
import { TOOLS } from './registry.ts';

test('resolvePaths honors tool home overrides', () => {
  const paths = resolvePaths({
    HOME: '/home/me',
    CODEX_HOME: '/codex',
    CLAUDE_CONFIG_DIR: '/claude',
    COPILOT_HOME: '/copilot',
    XDG_CACHE_HOME: '/cache',
  });

  assert.equal(paths.codexHome, '/codex');
  assert.equal(paths.claudeHome, '/claude');
  assert.equal(paths.copilotHome, '/copilot');
  assert.equal(paths.xdgCacheHome, '/cache');
  assert.equal(paths.stateDir, '/home/me/.agents/agents-config');
});

test('Antigravity, agy and Gemini CLI share one global instructions file', () => {
  const paths = resolvePaths({ HOME: '/home/me' });

  const files = new Set(
    (['antigravity', 'antigravity-cli', 'gemini-cli'] as const).map((id) =>
      TOOLS[id].global.instructions(paths),
    ),
  );

  assert.deepEqual([...files], ['/home/me/.gemini/AGENTS.md']);
});

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
