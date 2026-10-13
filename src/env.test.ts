import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

import {
  DEFAULT_SKILLS_SH_URL,
  gitEnvironment,
  resolveAgyBin,
  resolveAgyConfig,
  resolveAgyExtraArgs,
  resolvePaths,
  resolveSkillsShUrl,
} from './env.ts';
import { EnvironmentError } from './errors.ts';
import { tempDir } from './test-support/fixtures.ts';
import { isolatedGitEnv } from './test-support/git.ts';

const run = promisify(execFile);

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

test('resolveAgyBin and resolveAgyConfig reject a relative AGY_BIN', () => {
  assert.throws(
    () => resolveAgyBin({ AGY_BIN: 'bin/agy' }),
    (error) =>
      error instanceof EnvironmentError &&
      /AGY_BIN must be an absolute path/.test(error.message),
  );
  assert.throws(() => resolveAgyConfig({ AGY_BIN: 'agy' }), EnvironmentError);
  assert.equal(resolveAgyBin({ AGY_BIN: '  ' }), undefined);
  assert.equal(resolveAgyBin({ AGY_BIN: '/opt/agy' }), '/opt/agy');
});

test('resolveAgyBin ignores AGY_EXTRA_ARGS so other runners never parse it', () => {
  assert.equal(
    resolveAgyBin({ AGY_BIN: '/opt/agy', AGY_EXTRA_ARGS: 'not-json' }),
    '/opt/agy',
  );
});

test('resolveAgyExtraArgs ignores AGY_BIN so --binary can replace it', () => {
  assert.deepEqual(
    resolveAgyExtraArgs({ AGY_BIN: 'relative/agy', AGY_EXTRA_ARGS: '["-v"]' }),
    ['-v'],
  );
  assert.deepEqual(resolveAgyExtraArgs({}), []);
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

test('gitEnvironment drops repository config, grafts, replacements and shallow files', () => {
  const env = gitEnvironment({
    PATH: '/bin',
    GIT_CONFIG: '/work/app/.git/config',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/tmp/hooks'",
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: '/tmp/run.sh',
    GIT_GRAFT_FILE: '/work/app/.git/info/grafts',
    GIT_IMPLICIT_WORK_TREE: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_REPLACE_REF_BASE: 'refs/other/',
    GIT_SHALLOW_FILE: '/work/app/.git/shallow',
    GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
    GIT_CONFIG_SYSTEM: '/etc/gitconfig',
    GIT_SSH_COMMAND: 'ssh -i key',
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
    GIT_CONFIG_SYSTEM: '/etc/gitconfig',
    GIT_SSH_COMMAND: 'ssh -i key',
    GIT_TERMINAL_PROMPT: '0',
  });
});

test('gitEnvironment drops every variable git lists as local to a repository', async (t) => {
  const home = await tempDir(t);
  const { stdout } = await run('git', ['rev-parse', '--local-env-vars'], {
    cwd: home,
    env: isolatedGitEnv(home),
  });
  const names = stdout.split('\n').filter(Boolean);

  const env = gitEnvironment(
    Object.fromEntries(names.map((name) => [name, 'set'])),
  );

  assert.ok(names.includes('GIT_DIR'));
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: '0' });
});

test('resolveSkillsShUrl defaults to https://skills.sh and validates overrides', () => {
  const validEnv = { SKILLS_SH_URL: 'http://127.0.0.1:4321/' };
  const blankEnv = { SKILLS_SH_URL: '  ' };

  const defaultUrl = resolveSkillsShUrl({});
  const blankUrl = resolveSkillsShUrl(blankEnv);
  const customUrl = resolveSkillsShUrl(validEnv);

  assert.equal(defaultUrl, DEFAULT_SKILLS_SH_URL);
  assert.equal(blankUrl, DEFAULT_SKILLS_SH_URL);
  assert.equal(customUrl, 'http://127.0.0.1:4321');
  assert.throws(
    () => resolveSkillsShUrl({ SKILLS_SH_URL: 'not-a-url' }),
    EnvironmentError,
  );
  assert.throws(
    () => resolveSkillsShUrl({ SKILLS_SH_URL: 'file:///tmp/skills' }),
    EnvironmentError,
  );
});
