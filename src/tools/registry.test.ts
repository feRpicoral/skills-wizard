import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePaths } from '../env.ts';
import { TOOLS } from './registry.ts';

test('Antigravity, agy and Gemini CLI share one global instructions file', () => {
  const paths = resolvePaths({ HOME: '/home/me' });

  const files = new Set(
    (['antigravity', 'antigravity-cli', 'gemini-cli'] as const).map((id) =>
      TOOLS[id].global.instructions(paths),
    ),
  );

  assert.deepEqual([...files], ['/home/me/.gemini/AGENTS.md']);
});
