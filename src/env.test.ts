import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolvePaths } from './env.ts';
import { EnvironmentError } from './errors.ts';

test('resolvePaths honors tool home overrides', () => {
  const paths = resolvePaths({
    HOME: '/home/me',
    CODEX_HOME: '/codex',
    CLAUDE_CONFIG_DIR: '/claude',
    COPILOT_HOME: '/copilot',
  });

  assert.deepEqual(paths, {
    home: '/home/me',
    stateDir: '/home/me/.agents/agents-config',
    claudeHome: '/claude',
    codexHome: '/codex',
    geminiHome: '/home/me/.gemini',
    copilotHome: '/copilot',
    localBin: '/home/me/.local/bin',
  });
});

test('resolvePaths treats empty values as unset', () => {
  const paths = resolvePaths({ HOME: '/home/me', CODEX_HOME: ' ' });

  assert.equal(paths.codexHome, '/home/me/.codex');
});

test('resolvePaths rejects relative tool homes', () => {
  assert.throws(
    () => resolvePaths({ HOME: '/home/me', CLAUDE_CONFIG_DIR: 'relative' }),
    EnvironmentError,
  );
});
