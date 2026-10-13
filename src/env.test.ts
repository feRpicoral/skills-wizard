import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gitEnvironment, resolvePaths } from './env.ts';
import { EnvironmentError } from './errors.ts';

test('resolvePaths honors tool home overrides', () => {
  const paths = resolvePaths({
    HOME: '/home/me',
    CODEX_HOME: '/codex',
    CLAUDE_CONFIG_DIR: '/claude',
    COPILOT_HOME: '/copilot',
    XDG_CACHE_HOME: '/cache',
  });

  assert.deepEqual(paths, {
    home: '/home/me',
    stateDir: '/home/me/.agents/agents-config',
    skillsDir: '/home/me/.agents/skills',
    sourcesDir: '/cache/agents-config/sources',
    claudeHome: '/claude',
    codexHome: '/codex',
    geminiHome: '/home/me/.gemini',
    copilotHome: '/copilot',
    localBin: '/home/me/.local/bin',
  });
});

test('resolvePaths keeps the source cache in ~/.cache by default', () => {
  const paths = resolvePaths({ HOME: '/home/me', XDG_CACHE_HOME: '' });

  assert.equal(paths.sourcesDir, '/home/me/.cache/agents-config/sources');
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

test('resolvePaths rejects a relative cache directory', () => {
  assert.throws(
    () => resolvePaths({ HOME: '/home/me', XDG_CACHE_HOME: 'cache' }),
    EnvironmentError,
  );
});

test('gitEnvironment keeps the environment and turns off credential prompts', () => {
  const env = gitEnvironment({ PATH: '/bin' });

  assert.deepEqual(env, { PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
});

test('gitEnvironment drops variables that point git at another repository', () => {
  const env = gitEnvironment({
    PATH: '/bin',
    GIT_DIR: '/work/app/.git',
    GIT_WORK_TREE: '/work/app',
    GIT_INDEX_FILE: '/work/app/.git/index',
    GIT_OBJECT_DIRECTORY: '/work/app/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/work/other/.git/objects',
    GIT_COMMON_DIR: '/work/app/.git',
    GIT_NAMESPACE: 'ns',
    GIT_PREFIX: 'src/',
    GIT_CONFIG_NOSYSTEM: '1',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
});
