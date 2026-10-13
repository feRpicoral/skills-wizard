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
  tempDir,
  tempSearchPath,
  writeFiles,
} from './test-support/fixtures.ts';

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
