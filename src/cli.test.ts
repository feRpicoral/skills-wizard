import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { isSystemError } from './cli.ts';
import { tempDir, tempSearchPath } from './test-support/fixtures.ts';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, 'cli.ts');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  extraPath?: string;
}

type Cli = (args: string[], options?: CliOptions) => Promise<Result>;

interface Sandbox {
  home: string;
  cli: Cli;
}

// The CLI only sees node and git, so variable lookups and tool detection
// cannot reach other executables (such as gh) or the network.
async function sandbox(t: TestContext): Promise<Sandbox> {
  const home = await tempDir(t);
  const searchPath = await tempSearchPath(t, ['node', 'git']);
  const cli: Cli = async (args, { extraPath } = {}) => {
    const path = extraPath
      ? `${extraPath}${delimiter}${searchPath}`
      : searchPath;
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
        env: { HOME: home, PATH: path, GIT_CONFIG_NOSYSTEM: '1' },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      return {
        code: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
    }
  };
  return { home, cli };
}

test('rejects unknown tools with a usage error', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli(['init', '--global', '--yes', '--tools', 'nope']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown tools: nope/);
});

test('rejects options that do not apply to the command', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli(['sync', '--tools', 'codex']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--tools does not apply to sync/);
});

test('without a terminal, no arguments print the help', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli([]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage: agents-config/);
});

test('without a terminal, flags without a command are a usage error', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli(['--global', '--tools', 'codex']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--global, --tools must follow a command/);
  assert.equal(result.stdout, '');
});

test('names of built-in object properties are unknown commands', async (t) => {
  const { cli } = await sandbox(t);

  const results = await Promise.all(
    ['toString', '__proto__', 'constructor'].map((name) => cli([name])),
  );

  assert.deepEqual(
    results.map((result) => result.code),
    [2, 2, 2],
  );
});

test('isSystemError matches only OS errno exceptions and not Node internal errors', () => {
  const typeErr = Object.assign(new TypeError('bad argument'), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  const fsErr = Object.assign(new Error('ENOENT: no such file'), {
    code: 'ENOENT',
    errno: -2,
  });

  assert.equal(isSystemError(typeErr), false);
  assert.equal(isSystemError(fsErr), true);
});
