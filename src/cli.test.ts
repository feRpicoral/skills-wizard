import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

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

function manifestPath(home: string): string {
  return join(home, '.agents', 'agents-config', 'manifest.json');
}

function projectsPath(home: string): string {
  return join(home, '.agents', 'agents-config', 'projects.json');
}

function projectManifestPath(project: string): string {
  return join(project, '.agents', 'agents-config.json');
}

interface RecordedBlockParams {
  file: string;
  id: string;
}

async function addRecordedBlock({
  file,
  id,
}: RecordedBlockParams): Promise<void> {
  const manifest = JSON.parse(await readFile(file, 'utf8')) as {
    blocks: string[];
  };
  manifest.blocks.push(id);
  await writeFile(file, JSON.stringify(manifest));
}

test('init --dry-run prints the plan and writes nothing', async (t) => {
  const { home, cli } = await sandbox(t);

  const result = await cli([...INSTALL, '--dry-run']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /create\s+~\/\.codex\/AGENTS\.md/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init without a terminal and without --yes writes nothing', async (t) => {
  const { home, cli } = await sandbox(t);

  const result = await cli(INSTALL.filter((arg) => arg !== '--yes'));

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Re-run with --yes/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init installs and doctor then finds no problems', async (t) => {
  const { cli } = await sandbox(t);

  const install = await cli(INSTALL);
  const doctor = await cli(['doctor']);

  assert.equal(install.code, 0);
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /No problems found/);
});

test('sync reapplies a recorded install after a file was edited', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'edited\n');

  const doctor = await cli(['doctor']);
  const sync = await cli(['sync', '--yes']);

  assert.match(doctor.stdout, /out of date/);
  assert.equal(sync.code, 0);
  assert.match(sync.stdout, /update\s+~\/\.codex\/AGENTS\.md/);
});

test('init warns when ~/.local/bin is not on PATH after linking the command', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli([...INSTALL, '--link-command']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\.local\/bin is not on your PATH/);
});

test('init accepts ~/.local/bin on PATH written with a trailing slash', async (t) => {
  const { home, cli } = await sandbox(t);

  const result = await cli([...INSTALL, '--link-command'], {
    extraPath: `${join(home, '.local', 'bin')}/`,
  });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /not on your PATH/);
});

test('an empty tool list removes everything that was installed', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);

  const result = await cli(['init', '--global', '--yes', '--tools', '']);

  assert.equal(result.code, 0);
  await assert.rejects(lstat(join(home, '.codex', 'AGENTS.md')), {
    code: 'ENOENT',
  });
  await assert.rejects(lstat(manifestPath(home)), { code: 'ENOENT' });
});

test('init drops recorded blocks that left the library and still installs', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const result = await cli(['init', '--global', '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no longer in the library.*core\/removed/);
});

test('sync drops recorded blocks that left the library and still applies', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const result = await cli(['sync', '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no longer in the library.*core\/removed/);
  assert.doesNotMatch(
    await readFile(manifestPath(home), 'utf8'),
    /core\/removed/,
  );
});

test('doctor warns that sync will drop blocks that left the library', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const result = await cli(['doctor']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /core\/removed; agents-config sync will drop/);
  assert.match(await readFile(manifestPath(home), 'utf8'), /core\/removed/);
});

async function clearRecordedVariables(file: string): Promise<void> {
  const manifest = JSON.parse(await readFile(file, 'utf8')) as {
    variables: Record<string, string>;
  };
  manifest.variables = {};
  await writeFile(file, JSON.stringify(manifest));
}

test('sync stops with the init command when a block gains a variable it cannot look up', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await clearRecordedVariables(manifestPath(home));

  const result = await cli(['sync', '--yes']);

  assert.equal(result.code, 2);
  assert.match(
    result.stderr,
    /githubUsername.*agents-config init --global --var githubUsername=<value>/,
  );
});

test('sync looks up a variable a block gained and records it', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await clearRecordedVariables(manifestPath(home));
  await writeFile(join(home, '.gitconfig'), '[github]\n\tuser = hubot\n');

  const result = await cli(['sync', '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /githubUsername=hubot/);
  assert.match(
    await readFile(manifestPath(home), 'utf8'),
    /"githubUsername": "hubot"/,
  );
});

test('doctor reports a variable a block gained without crashing', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await clearRecordedVariables(manifestPath(home));

  const result = await cli(['doctor']);

  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /^error\s+.*githubUsername.*agents-config init --global --var githubUsername=<value>/m,
  );
  assert.equal(result.stderr, '');
});

test('doctor still reports conflicts when a gained variable has no value', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await clearRecordedVariables(manifestPath(home));
  const marker = '<!-- BEGIN:agents-config -->';
  await writeFile(
    join(home, '.codex', 'AGENTS.md'),
    `${marker}\n${marker}\n<!-- END:agents-config -->\n`,
  );

  const result = await cli(['doctor']);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^error\s+.*githubUsername.*init --global/m);
  assert.match(result.stdout, /^error\s+~\/\.codex\/AGENTS\.md: /m);
  assert.doesNotMatch(result.stdout, /out of date/);
});

test('doctor says sync will record a gained variable it can look up', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await clearRecordedVariables(manifestPath(home));
  await writeFile(join(home, '.gitconfig'), '[github]\n\tuser = hubot\n');

  const result = await cli(['doctor']);

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /^warn\s+.*agents-config sync will record githubUsername=hubot/m,
  );
  assert.doesNotMatch(result.stdout, /init --global --var/);
});

async function doctorWithGeminiExtras(
  { home, cli }: Sandbox,
  tools: string,
): Promise<Result> {
  await cli(INSTALL.map((arg) => (arg === 'codex' ? tools : arg)));
  await writeFiles(join(home, '.gemini'), {
    'GEMINI.md': 'extra\n',
    'config/AGENTS.md': 'extra\n',
    'config/GEMINI.md': 'extra\n',
  });
  return cli(['doctor']);
}

test('doctor warns about every extra Gemini file Antigravity loads', async (t) => {
  const box = await sandbox(t);

  const result = await doctorWithGeminiExtras(box, 'antigravity');

  for (const file of ['GEMINI.md', 'config/AGENTS.md', 'config/GEMINI.md']) {
    assert.match(
      result.stdout,
      new RegExp(
        `~/\\.gemini/${file.replace('.', '\\.')} is loaded in addition`,
      ),
    );
  }
});

test('doctor warns Gemini CLI users only about ~/.gemini/GEMINI.md', async (t) => {
  const box = await sandbox(t);

  const result = await doctorWithGeminiExtras(box, 'gemini-cli');

  assert.match(result.stdout, /~\/\.gemini\/GEMINI\.md is loaded in addition/);
  assert.doesNotMatch(result.stdout, /\.gemini\/config\//);
});

const PROJECT_INSTALL = ['--yes', '--tools', 'codex'];

test('sync drops recorded blocks that are no longer available for the scope', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await cli(['init', '--project', project, ...PROJECT_INSTALL]);
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const result = await cli(['sync', '--project', project, '--yes']);

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /no longer available for project scope.*core\/identity/,
  );
  assert.doesNotMatch(
    await readFile(projectManifestPath(project), 'utf8'),
    /core\/identity/,
  );
});

test('init drops recorded blocks that are no longer available for the scope', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await cli(['init', '--project', project, ...PROJECT_INSTALL]);
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const result = await cli(['init', '--project', project, '--yes']);

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /no longer available for project scope.*core\/identity/,
  );
});

test('doctor warns that sync will drop blocks no longer available for the scope', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await cli(['init', '--project', project, ...PROJECT_INSTALL]);
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const result = await cli(['doctor', '--project', project]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /core\/identity; agents-config sync will drop/);
});

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

test('sync without a recorded install is a usage error', async (t) => {
  const { cli } = await sandbox(t);

  const result = await cli(['sync', '--yes']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /run agents-config init first/);
});

test('a keep-local project copied into another repository still syncs', async (t) => {
  const { cli } = await sandbox(t);
  const repo = await tempDir(t);
  const other = await tempDir(t);
  const copy = join(other, 'app');
  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['init', '-q'], { cwd: other });
  await cli([
    'init',
    '--project',
    repo,
    '--yes',
    '--tools',
    'codex',
    '--local',
  ]);
  await cp(join(repo, '.agents'), join(copy, '.agents'), { recursive: true });

  const result = await cli(['sync', '--project', copy, '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /belong to another repository/);
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

test('a package.json that links outside the project is not read for the title', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await symlink('/dev/zero', join(project, 'package.json'));

  const result = await cli([
    'init',
    '--project',
    project,
    '--yes',
    '--tools',
    'codex',
  ]);

  assert.equal(result.code, 0);
  assert.match(
    await readFile(join(project, 'AGENTS.md'), 'utf8'),
    new RegExp(`^# ${basename(project)}\n`),
  );
});

test('doctor names project files relative to the project', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await cli(['init', '--project', project, '--yes', '--tools', 'codex']);
  await writeFile(join(project, 'AGENTS.md'), 'edited\n');

  const result = await cli(['doctor', '--project', project]);

  assert.match(result.stdout, /^warn\s+AGENTS\.md is out of date/m);
});

test('sync and init drop keep-local with a notice once the project leaves git', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: project });
  const install = ['init', '--project', project, '--yes', '--tools', 'codex'];
  await cli([...install, '--local']);
  await rm(join(project, '.git'), { recursive: true, force: true });

  const sync = await cli(['sync', '--project', project, '--yes']);
  const init = await cli(install);

  assert.equal(sync.code, 0);
  assert.match(sync.stdout, /no longer in a git repository/);
  assert.doesNotMatch(sync.stdout, /another repository/);
  assert.equal(init.code, 0);
  assert.match(
    await readFile(join(project, '.agents', 'agents-config.json'), 'utf8'),
    /"keepLocal": false/,
  );
});

test('a project install is recorded and removing it drops the record', async (t) => {
  const { home, cli } = await sandbox(t);
  const project = await realpath(await tempDir(t));
  const install = ['init', '--project', project, '--yes', '--tools'];
  await cli([...install, 'codex']);
  const recorded = await readFile(projectsPath(home), 'utf8');

  await cli([...install, '']);

  assert.deepEqual(JSON.parse(recorded), { version: 1, projects: [project] });
  await assert.rejects(lstat(projectsPath(home)), { code: 'ENOENT' });
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

test('init with --preset defaults to lean style when a global install exists and passes doctor', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await cli(INSTALL);
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'orders-api',
      description: 'Orders backend service.',
      scripts: {
        build: 'nest build',
        test: 'jest',
      },
    }),
  );

  const initResult = await cli([
    'init',
    '--project',
    project,
    '--preset',
    'nestjs-api',
    '--tools',
    'codex',
    '--yes',
  ]);
  const doctorResult = await cli(['doctor', '--project', project]);
  const agentsMd = await readFile(join(project, 'AGENTS.md'), 'utf8');
  const manifest = JSON.parse(
    await readFile(join(project, '.agents', 'agents-config.json'), 'utf8'),
  ) as {
    blocks: string[];
    skills: string[];
    options: { preset?: string; style?: string };
  };

  assert.equal(initResult.code, 0);
  assert.equal(doctorResult.code, 0);
  assert.match(doctorResult.stdout, /No problems found/);
  assert.match(agentsMd, /^# orders-api\n\nOrders backend service\./);
  assert.match(agentsMd, /## Commands\n\n- Install: `yarn install`/);
  assert.match(agentsMd, /## NestJS/);
  assert.doesNotMatch(agentsMd, /## Testing/);
  assert.equal(manifest.options.preset, 'nestjs-api');
  assert.equal(manifest.options.style, 'lean');
  assert.deepEqual(manifest.skills, [
    'eslint-configuration',
    'prettier-configuration',
    'nestjs-module',
  ]);
});

test('init without a global install defaults to self-contained style and sync preserves edited seed preamble', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'standalone-service' }),
  );

  const initResult = await cli([
    'init',
    '--project',
    project,
    '--preset',
    'node-tool',
    '--skills',
    '',
    '--tools',
    'codex',
    '--yes',
  ]);
  const initialAgents = await readFile(join(project, 'AGENTS.md'), 'utf8');
  const customPreamble = initialAgents.replace(
    '# standalone-service',
    '# standalone-service\n\nCustom architecture notes preserved outside managed region.',
  );
  await writeFile(join(project, 'AGENTS.md'), customPreamble);
  const syncResult = await cli(['sync', '--project', project, '--yes']);
  const afterSync = await readFile(join(project, 'AGENTS.md'), 'utf8');
  const manifest = JSON.parse(
    await readFile(join(project, '.agents', 'agents-config.json'), 'utf8'),
  ) as { options: { style?: string } };

  assert.equal(initResult.code, 0);
  assert.equal(syncResult.code, 0);
  assert.equal(manifest.options.style, 'self-contained');
  assert.match(
    afterSync,
    /Custom architecture notes preserved outside managed region\./,
  );
  assert.match(afterSync, /## Testing/);
  assert.match(afterSync, /## TypeScript/);
});

test('rejects invalid --preset or --style flags and rejects them on global installs', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);

  const [badPreset, badStyle, globalPreset, globalStyle] = await Promise.all([
    cli(['init', '--project', project, '--preset', 'rails', '--yes']),
    cli(['init', '--project', project, '--style', 'full', '--yes']),
    cli([...INSTALL, '--preset', 'node-tool']),
    cli([...INSTALL, '--style', 'lean']),
  ]);

  assert.equal(badPreset.code, 2);
  assert.match(badPreset.stderr, /--preset must be one of/);
  assert.equal(badStyle.code, 2);
  assert.match(badStyle.stderr, /--style must be one of lean, self-contained/);
  assert.equal(globalPreset.code, 2);
  assert.match(
    globalPreset.stderr,
    /--preset only applies to project installs/,
  );
  assert.equal(globalStyle.code, 2);
  assert.match(globalStyle.stderr, /--style only applies to project installs/);
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

test('doctor warns that sync will stop keeping files local once the project leaves git', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: project });
  await cli(['init', '--project', project, ...PROJECT_INSTALL, '--local']);
  await rm(join(project, '.git'), { recursive: true, force: true });

  const result = await cli(['doctor', '--project', project]);

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /^warn\s+.*no longer in a git repository; agents-config sync will stop keeping its files local/m,
  );
  assert.doesNotMatch(result.stdout, /another repository/);
});

test('upgrading a pre-PR global manifest drops git/github-repo-setup and stack/supabase-prisma and points to replacement skills', async (t) => {
  const { home, cli } = await sandbox(t);
  await cli(INSTALL);
  await addRecordedBlock({
    file: manifestPath(home),
    id: 'git/github-repo-setup',
  });
  await addRecordedBlock({
    file: manifestPath(home),
    id: 'stack/supabase-prisma',
  });

  const doctor = await cli(['doctor']);
  const sync = await cli(['sync', '--yes']);
  const updatedManifest = await readFile(manifestPath(home), 'utf8');

  assert.equal(doctor.code, 0);
  assert.match(
    doctor.stdout,
    /git\/github-repo-setup.*use the github-repo-setup skill instead/,
  );
  assert.match(
    doctor.stdout,
    /stack\/supabase-prisma.*use the supabase-prisma skill instead/,
  );
  assert.equal(sync.code, 0);
  assert.match(
    sync.stdout,
    /git\/github-repo-setup.*use the github-repo-setup skill instead/,
  );
  assert.match(
    sync.stdout,
    /stack\/supabase-prisma.*use the supabase-prisma skill instead/,
  );
  assert.doesNotMatch(
    updatedManifest,
    /git\/github-repo-setup|stack\/supabase-prisma/,
  );
});

test('re-running init with --style or --preset preserves recorded stack blocks and skills, and lean requires tool coverage', async (t) => {
  const { cli } = await sandbox(t);
  const project = await tempDir(t);
  await cli([
    'init',
    '--global',
    '--yes',
    '--tools',
    'claude-code',
    '--skills',
    '',
    '--var',
    'githubUsername=octocat',
  ]);
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'svc' }),
  );

  const firstInit = await cli([
    'init',
    '--project',
    project,
    '--tools',
    'codex',
    '--blocks',
    'core/task-execution,stack/typescript,stack/nextjs',
    '--skills',
    'skill-author',
    '--yes',
  ]);
  assert.equal(firstInit.code, 0);
  const firstManifest = JSON.parse(
    await readFile(projectManifestPath(project), 'utf8'),
  ) as {
    blocks: string[];
    skills: string[];
    options: { style?: string; preset?: string };
  };
  assert.equal(firstManifest.options.style, 'self-contained');

  const leanInit = await cli([
    'init',
    '--project',
    project,
    '--style',
    'lean',
    '--yes',
  ]);
  assert.equal(leanInit.code, 0);
  const leanManifest = JSON.parse(
    await readFile(projectManifestPath(project), 'utf8'),
  ) as {
    blocks: string[];
    skills: string[];
  };
  assert.deepEqual(leanManifest.blocks, ['stack/typescript', 'stack/nextjs']);
  assert.deepEqual(leanManifest.skills, ['skill-author']);

  const presetInit = await cli([
    'init',
    '--project',
    project,
    '--preset',
    'node-tool',
    '--yes',
  ]);
  assert.equal(presetInit.code, 0);
  const presetManifest = JSON.parse(
    await readFile(projectManifestPath(project), 'utf8'),
  ) as {
    blocks: string[];
    skills: string[];
    options: { preset?: string };
  };
  assert.equal(presetManifest.blocks.includes('stack/nextjs'), true);
  assert.equal(presetManifest.blocks.includes('stack/lint-format'), true);
  assert.equal(presetManifest.skills.includes('skill-author'), true);
  assert.equal(presetManifest.skills.includes('eslint-configuration'), true);

  const raw = JSON.parse(
    await readFile(projectManifestPath(project), 'utf8'),
  ) as { options: { preset?: string } };
  raw.options.preset = 'retired-preset';
  await writeFile(projectManifestPath(project), JSON.stringify(raw));

  const doctor = await cli(['doctor', '--project', project]);
  const sync = await cli(['sync', '--project', project, '--yes']);
  assert.equal(doctor.code, 0);
  assert.match(
    doctor.stdout,
    /Preset "retired-preset" is no longer recognized/,
  );
  assert.equal(sync.code, 0);
  assert.match(sync.stdout, /Preset "retired-preset" is no longer recognized/);
});

test('add rejects invalid --source, --ref, --category, and disallowed flags', async (t) => {
  const { cli } = await sandbox(t);

  const [badSource, badRef, emptyCategory, badFlag, missingTarget] =
    await Promise.all([
      cli(['add', 'react', '--source', 'npm']),
      cli(['add', 'owner/repo', '--ref=-bad-ref']),
      cli(['add', 'owner/repo', '--category', '   ']),
      cli(['add', 'owner/repo', '--preset', 'node-tool']),
      cli(['add', '--yes']),
    ]);

  assert.equal(badSource.code, 2);
  assert.match(
    badSource.stderr,
    /--source must be one of skills-sh, awesome, all/,
  );
  assert.equal(badRef.code, 2);
  assert.match(badRef.stderr, /--ref must be a valid branch, tag or commit/);
  assert.equal(emptyCategory.code, 2);
  assert.match(emptyCategory.stderr, /--category must not be empty/);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.stderr, /--preset does not apply to add/);
  assert.equal(missingTarget.code, 2);
  assert.match(
    missingTarget.stderr,
    /Pass a search query, owner\/repo\[@skill\], or GitHub URL/,
  );
});
