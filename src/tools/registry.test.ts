import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePaths } from '../env.ts';
import { TOOL_IDS, TOOLS } from './registry.ts';

test('Antigravity, agy and Gemini CLI share one global instructions file', () => {
  const paths = resolvePaths({ HOME: '/home/me' });

  const files = new Set(
    (['antigravity', 'antigravity-cli', 'gemini-cli'] as const).map((id) =>
      TOOLS[id].global.instructions(paths),
    ),
  );

  assert.deepEqual([...files], ['/home/me/.gemini/AGENTS.md']);
});

test('only tools that do not read ~/.agents/skills get skill links', () => {
  const paths = resolvePaths({ HOME: '/home/me' });

  const links = TOOL_IDS.flatMap((id) => {
    const dir = TOOLS[id].global.skills?.(paths);
    return dir ? [[id, dir]] : [];
  });

  assert.deepEqual(links, [
    ['antigravity', '/home/me/.gemini/config/skills'],
    ['antigravity-cli', '/home/me/.gemini/antigravity-cli/skills'],
    ['claude-code', '/home/me/.claude/skills'],
  ]);
});

test('Gemini CLI and Copilot also read skills from their own folders', () => {
  const paths = resolvePaths({ HOME: '/home/me' });

  const extra = TOOL_IDS.flatMap((id) => {
    const dirs = TOOLS[id].global.extraSkills?.(paths) ?? [];
    return dirs.map((dir) => [id, dir]);
  });

  assert.deepEqual(extra, [
    ['gemini-cli', '/home/me/.gemini/skills'],
    ['copilot', '/home/me/.copilot/skills'],
  ]);
});
