import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import { isSystemError } from './cli.ts';
import {
  skillSource,
  tempDir,
  tempSearchPath,
  writeFiles,
} from './test-support/fixtures.ts';
import { isolatedGitEnv } from './test-support/git.ts';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, 'cli.ts');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  extraPath?: string;
  env?: Record<string, string>;
  cwd?: string;
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
  const cli: Cli = async (args, { extraPath, env = {}, cwd } = {}) => {
    const path = extraPath
      ? `${extraPath}${delimiter}${searchPath}`
      : searchPath;
    try {
      const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
        env: { HOME: home, PATH: path, GIT_CONFIG_NOSYSTEM: '1', ...env },
        ...(cwd !== undefined ? { cwd } : {}),
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

const INSTALL = [
  'init',
  '--global',
  '--yes',
  '--tools',
  'codex',
  '--skills',
  '',
  '--var',
  'githubUsername=octocat',
];

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

test('a --baseline ref without a command is a usage error', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli(['--baseline=main']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--baseline must follow a command/);
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

test('rejects an unknown skill mode', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli([...INSTALL, '--skill-mode', 'mirror']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--skill-mode must be one of copy, link/);
});

test('rejects skills that are not in the catalog or skills/', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli([
    'init',
    '--global',
    '--yes',
    '--tools',
    'codex',
    '--skills',
    'not-a-skill',
    '--var',
    'githubUsername=octocat',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown skills: not-a-skill/);
});

test('rejects a skill mode for project installs', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);

  const result = await cli([
    'init',
    '--project',
    project,
    '--yes',
    '--tools',
    'codex',
    '--skill-mode',
    'link',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--skill-mode only applies to system-wide/);
});

test('rejects disallowed flags on update, adopt and skill validate', async (t) => {
  const { home, cli } = await sandbox(t);

  const [updateResult, adoptResult, skillResult] = await Promise.all([
    cli(['update', '--global']),
    cli(['adopt', '--project', home]),
    cli(['skill', 'unknown']),
  ]);

  assert.equal(updateResult.code, 2);
  assert.match(updateResult.stderr, /--global does not apply to update/);
  assert.equal(adoptResult.code, 2);
  assert.match(adoptResult.stderr, /--project does not apply to adopt/);
  assert.equal(skillResult.code, 2);
  assert.match(
    skillResult.stderr,
    /Usage: agents-config skill validate \[path\.\.\.\] \[--catalog\]/,
  );
});

test('cli rejects invalid numeric flags and accepts --baseline none and --cases for skill eval', async (t) => {
  const { cli } = await sandbox(t);

  const [badRuns, badThreshold, evalNoBaseline] = await Promise.all([
    cli(['skill', 'eval', 'some-skill', '--runs', '0']),
    cli(['skill', 'triggers', 'some-skill', '--threshold', 'not-num']),
    cli([
      'skill',
      'eval',
      'skill-author',
      '--runner',
      'fake',
      '--baseline',
      'none',
      '--cases',
      'casual-changelog-skill',
    ]),
  ]);

  assert.equal(badRuns.code, 2);
  assert.match(badRuns.stderr, /--runs must be a positive integer/);
  assert.equal(badThreshold.code, 2);
  assert.match(badThreshold.stderr, /--threshold must be a number/);
  assert.equal(evalNoBaseline.code, 0);
  assert.match(evalNoBaseline.stdout, /Evaluated skill-author with fake/);
});

test('skill subcommands reject flags that belong to another subcommand', async (t) => {
  const { cli } = await sandbox(t);

  const results = await Promise.all([
    cli(['skill', 'validate', '--runner', 'fake']),
    cli(['skill', 'new', 'Not_A_Name', '--runs', '2']),
    cli(['skill', 'eval', 'demo', '--split', 'train']),
    cli(['skill', 'triggers', 'demo', '--compare', 'main']),
    cli(['skill', 'triggers', 'demo', '--baseline', 'none']),
    cli(['skill', 'report', 'demo', '--parallel', '2']),
  ]);

  assert.deepEqual(
    results.map((result) => result.code),
    [2, 2, 2, 2, 2, 2],
  );
  const [validate, scaffold, evaluate, triggers, triggersBaseline, report] =
    results.map((result) => result.stderr);
  assert.match(validate ?? '', /--runner does not apply to skill validate/);
  assert.match(scaffold ?? '', /--runs does not apply to skill new/);
  assert.match(evaluate ?? '', /--split does not apply to skill eval/);
  assert.match(triggers ?? '', /--compare does not apply to skill triggers/);
  assert.match(
    triggersBaseline ?? '',
    /--baseline does not apply to skill triggers/,
  );
  assert.match(report ?? '', /--parallel does not apply to skill report/);
});

test('numeric skill flags accept only plain decimal numbers', async (t) => {
  const { cli } = await sandbox(t);
  const evalWith = (flag: string, value: string) =>
    cli(['skill', 'eval', 'skill-author', flag, value]);

  const rejected = await Promise.all([
    evalWith('--runs', ''),
    evalWith('--runs', '0x1'),
    evalWith('--runs', '1e1'),
    evalWith('--runs', '1.5'),
    evalWith('--parallel', ' 2'),
    evalWith('--timeout', '-5'),
    cli(['skill', 'triggers', 'skill-author', '--threshold', '0x1']),
    cli(['skill', 'triggers', 'skill-author', '--threshold', '']),
    cli(['skill', 'triggers', 'skill-author', '--threshold', '5e-1']),
  ]);

  for (const result of rejected) {
    assert.equal(result.code, 2, result.stderr);
    assert.match(
      result.stderr,
      /must be a (positive integer|number)|argument is ambiguous/,
    );
  }
});

// A throwaway git repository with one committed skill, so `--baseline <ref>`
// never depends on the state of this checkout.
async function skillRepo(t: TestContext): Promise<string> {
  const repo = await tempDir(t);
  await writeFiles(repo, {
    'skills/demo-skill/SKILL.md': skillSource('demo-skill'),
    'skills/demo-skill/evals/evals.json': JSON.stringify({
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'starter',
          prompt: 'Write output.md',
          expected_output: 'output.md exists',
          assertions: [{ type: 'file_exists', path: 'output.md' }],
        },
      ],
    }),
  });
  const env = isolatedGitEnv(repo);
  const git = (args: string[]) => run('git', args, { cwd: repo, env });
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '-A']);
  await git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '-m',
    'add demo-skill',
  ]);
  return repo;
}

test('--baseline <ref> is accepted before or after the skill name', async (t) => {
  const [repo, before_, after_] = await Promise.all([
    skillRepo(t),
    sandbox(t),
    sandbox(t),
  ]);

  const [before, after] = await Promise.all([
    before_.cli(
      ['skill', 'eval', '--baseline', 'main', 'demo-skill', '--runner', 'fake'],
      { cwd: repo },
    ),
    after_.cli(
      ['skill', 'eval', 'demo-skill', '--runner', 'fake', '--baseline', 'main'],
      { cwd: repo },
    ),
  ]);

  for (const result of [before, after]) {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /old_skill run 1\/1/);
    assert.doesNotMatch(result.stdout, /without_skill run/);
  }
});

test('--baseline before the skill name without a ref keeps the name', async (t) => {
  const [repo, { cli }] = await Promise.all([skillRepo(t), sandbox(t)]);

  const [bare, missing] = await Promise.all([
    cli(['skill', 'eval', '--baseline', 'demo-skill', '--runner', 'fake'], {
      cwd: repo,
    }),
    cli(['skill', 'eval', '--baseline', 'main', 'no-such-skill'], {
      cwd: repo,
    }),
  ]);

  assert.equal(bare.code, 0, bare.stderr);
  assert.match(bare.stdout, /without_skill run 1\/1/);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Skill "no-such-skill" was not found/);
});

test('--baseline <ref> cannot be combined with --compare or another --baseline', async (t) => {
  const { cli } = await sandbox(t);

  const results = await Promise.all([
    cli(['skill', 'eval', 'demo', '--baseline=main', '--compare', 'v1']),
    cli(['skill', 'eval', 'demo', '--baseline', 'main', '--compare=v1']),
    cli(['skill', 'eval', 'demo', '--baseline=main', '--no-baseline']),
    cli(['skill', 'eval', 'demo', '--baseline=main', '--baseline=v1']),
    cli(['skill', 'eval', 'demo', '--baseline=-x']),
    cli(['skill', 'eval', 'demo', '--compare=-x']),
  ]);

  assert.deepEqual(
    results.map((result) => result.code),
    [2, 2, 2, 2, 2, 2],
  );
  const messages = results.map((result) => result.stderr);
  assert.match(messages[0] ?? '', /either --baseline <ref> or --compare/);
  assert.match(messages[1] ?? '', /either --baseline <ref> or --compare/);
  assert.match(messages[2] ?? '', /Use one form of --baseline/);
  assert.match(messages[3] ?? '', /--baseline <ref> was given more than once/);
  assert.match(messages[4] ?? '', /--baseline ref must not start with "-"/);
  assert.match(messages[5] ?? '', /--compare ref must not start with "-"/);
});

test('a malformed AGY_EXTRA_ARGS only fails agy evals', async (t) => {
  const { cli } = await sandbox(t);
  const env = { AGY_EXTRA_ARGS: 'not-json', AGY_BIN: '/nonexistent/agy' };

  const [validate, fakeEval, agyEval, relativeBin] = await Promise.all([
    cli(['skill', 'validate', 'skills/skill-author'], { env }),
    cli(
      [
        'skill',
        'eval',
        'skill-author',
        '--runner',
        'fake',
        '--cases',
        'casual-changelog-skill',
      ],
      { env },
    ),
    cli(['skill', 'eval', 'skill-author', '--runner', 'agy'], { env }),
    cli(['skill', 'eval', 'skill-author'], { env: { AGY_BIN: 'agy' } }),
  ]);

  assert.equal(validate.code, 0, validate.stderr);
  assert.equal(fakeEval.code, 0, fakeEval.stderr);
  assert.equal(agyEval.code, 1);
  assert.match(agyEval.stderr, /AGY_EXTRA_ARGS must be a JSON array/);
  assert.equal(relativeBin.code, 1);
  assert.match(relativeBin.stderr, /AGY_BIN must be an absolute path/);
});
