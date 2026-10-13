import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import which from 'which';

import { tempDir } from './test-support/fixtures.ts';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, 'cli.ts');

let searchPath = '';

// The CLI only sees node and git, so variable lookups and tool detection
// cannot reach other executables (such as gh) or the network.
before(async () => {
  searchPath = await mkdtemp(join(tmpdir(), 'agents-config-bin-'));
  await symlink(process.execPath, join(searchPath, 'node'));
  await symlink(await which('git'), join(searchPath, 'git'));
});

after(() => rm(searchPath, { recursive: true, force: true }));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(home: string, args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { HOME: home, PATH: searchPath, GIT_CONFIG_NOSYSTEM: '1' },
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
}

const INSTALL = [
  'init',
  '--global',
  '--yes',
  '--tools',
  'codex',
  '--var',
  'githubUsername=octocat',
];

function manifestPath(home: string): string {
  return join(home, '.agents', 'agents-config', 'manifest.json');
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
  const home = await tempDir(t);

  const result = await cli(home, [...INSTALL, '--dry-run']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /create\s+~\/\.codex\/AGENTS\.md/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init without a terminal and without --yes writes nothing', async (t) => {
  const home = await tempDir(t);

  const result = await cli(
    home,
    INSTALL.filter((arg) => arg !== '--yes'),
  );

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Re-run with --yes/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init installs and doctor then finds no problems', async (t) => {
  const home = await tempDir(t);

  const install = await cli(home, INSTALL);
  const doctor = await cli(home, ['doctor']);

  assert.equal(install.code, 0);
  assert.equal(doctor.code, 0);
  assert.match(doctor.stdout, /No problems found/);
});

test('sync reapplies a recorded install after a file was edited', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'edited\n');

  const doctor = await cli(home, ['doctor']);
  const sync = await cli(home, ['sync', '--yes']);

  assert.match(doctor.stdout, /out of date/);
  assert.equal(sync.code, 0);
  assert.match(sync.stdout, /update\s+~\/\.codex\/AGENTS\.md/);
});

test('an empty tool list removes everything that was installed', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);

  const result = await cli(home, ['init', '--global', '--yes', '--tools', '']);

  assert.equal(result.code, 0);
  await assert.rejects(lstat(join(home, '.codex', 'AGENTS.md')), {
    code: 'ENOENT',
  });
  await assert.rejects(lstat(manifestPath(home)), { code: 'ENOENT' });
});

test('init drops recorded blocks that left the library and still installs', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const result = await cli(home, ['init', '--global', '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no longer in the library.*core\/removed/);
});

test('sync drops recorded blocks that left the library and still applies', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const result = await cli(home, ['sync', '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no longer in the library.*core\/removed/);
  assert.doesNotMatch(
    await readFile(manifestPath(home), 'utf8'),
    /core\/removed/,
  );
});

test('doctor warns that sync will drop blocks that left the library', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const result = await cli(home, ['doctor']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /core\/removed; agents-config sync will drop/);
  assert.match(await readFile(manifestPath(home), 'utf8'), /core\/removed/);
});

const PROJECT_INSTALL = ['--yes', '--tools', 'codex'];

test('sync drops recorded blocks that are no longer available for the scope', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);
  await cli(home, ['init', '--project', project, ...PROJECT_INSTALL]);
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const result = await cli(home, ['sync', '--project', project, '--yes']);

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
  const home = await tempDir(t);
  const project = await tempDir(t);
  await cli(home, ['init', '--project', project, ...PROJECT_INSTALL]);
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const result = await cli(home, ['init', '--project', project, '--yes']);

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /no longer available for project scope.*core\/identity/,
  );
});

test('doctor warns that sync will drop blocks no longer available for the scope', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);
  await cli(home, ['init', '--project', project, ...PROJECT_INSTALL]);
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const result = await cli(home, ['doctor', '--project', project]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /core\/identity; agents-config sync will drop/);
});

test('rejects unknown tools with a usage error', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, [
    'init',
    '--global',
    '--yes',
    '--tools',
    'nope',
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown tools: nope/);
});

test('rejects options that do not apply to the command', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, ['sync', '--tools', 'codex']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--tools does not apply to sync/);
});

test('sync without a recorded install is a usage error', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, ['sync', '--yes']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /run agents-config init first/);
});

test('a keep-local project copied out of its repository still syncs', async (t) => {
  const home = await tempDir(t);
  const repo = await tempDir(t);
  const copy = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: repo });
  await cli(home, [
    'init',
    '--project',
    repo,
    '--yes',
    '--tools',
    'codex',
    '--local',
  ]);
  await cp(join(repo, '.agents'), join(copy, '.agents'), { recursive: true });

  const result = await cli(home, ['sync', '--project', copy, '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /belong to another repository/);
});

test('names of built-in object properties are unknown commands', async (t) => {
  const home = await tempDir(t);

  const results = await Promise.all(
    ['toString', '__proto__', 'constructor'].map((name) => cli(home, [name])),
  );

  assert.deepEqual(
    results.map((result) => result.code),
    [2, 2, 2],
  );
});

test('a package.json that links outside the project is not read for the title', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);
  await symlink('/dev/zero', join(project, 'package.json'));

  const result = await cli(home, [
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
  const home = await tempDir(t);
  const project = await tempDir(t);
  await cli(home, ['init', '--project', project, '--yes', '--tools', 'codex']);
  await writeFile(join(project, 'AGENTS.md'), 'edited\n');

  const result = await cli(home, ['doctor', '--project', project]);

  assert.match(result.stdout, /^warn\s+AGENTS\.md is out of date/m);
});

test('sync and init drop keep-local with a notice once the project leaves git', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: project });
  const install = ['init', '--project', project, '--yes', '--tools', 'codex'];
  await cli(home, [...install, '--local']);
  await rm(join(project, '.git'), { recursive: true, force: true });

  const sync = await cli(home, ['sync', '--project', project, '--yes']);
  const init = await cli(home, install);

  assert.equal(sync.code, 0);
  assert.match(sync.stdout, /no longer in a git repository/);
  assert.equal(init.code, 0);
  assert.match(
    await readFile(join(project, '.agents', 'agents-config.json'), 'utf8'),
    /"keepLocal": false/,
  );
});
