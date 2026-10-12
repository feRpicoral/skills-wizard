import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gitEnvironment, resolveAgyConfig, resolvePaths } from './env.ts';
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
    evalsDir: '/home/me/.agents/agents-config/evals',
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

test('resolveAgyConfig reads AGY_BIN and parses AGY_EXTRA_ARGS JSON array', () => {
  const config = resolveAgyConfig({
    AGY_BIN: '/opt/agy/bin/agy',
    AGY_EXTRA_ARGS: '["--verbose","--model=test"]',
  });

  assert.deepEqual(config, {
    bin: '/opt/agy/bin/agy',
    extraArgs: ['--verbose', '--model=test'],
  });
});

test('resolveAgyConfig defaults to empty extraArgs when unset', () => {
  const config = resolveAgyConfig({});

  assert.deepEqual(config, { extraArgs: [] });
});

test('resolveAgyConfig rejects invalid AGY_EXTRA_ARGS JSON or non-string arrays', () => {
  assert.throws(
    () => resolveAgyConfig({ AGY_EXTRA_ARGS: 'not-json' }),
    EnvironmentError,
  );
  assert.throws(
    () => resolveAgyConfig({ AGY_EXTRA_ARGS: '{"flag":true}' }),
    EnvironmentError,
  );
  assert.throws(
    () => resolveAgyConfig({ AGY_EXTRA_ARGS: '[123]' }),
    EnvironmentError,
  );
});
