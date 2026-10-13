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
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { tempDir } from './test-support/fixtures.ts';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, 'cli.ts');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(home: string, args: string[]): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { HOME: home, PATH: process.env.PATH ?? '' },
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

interface RecordedBlockParams {
  home: string;
  id: string;
}

async function addRecordedBlock({
  home,
  id,
}: RecordedBlockParams): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath(home), 'utf8')) as {
    blocks: string[];
  };
  manifest.blocks.push(id);
  await writeFile(manifestPath(home), JSON.stringify(manifest));
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
  await addRecordedBlock({ home, id: 'core/removed' });

  const result = await cli(home, ['init', '--global', '--yes']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /no longer in the library.*core\/removed/);
});

test('sync drops recorded blocks that left the library and still applies', async (t) => {
  const home = await tempDir(t);
  await cli(home, INSTALL);
  await addRecordedBlock({ home, id: 'core/removed' });

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
  await addRecordedBlock({ home, id: 'core/removed' });

  const result = await cli(home, ['doctor']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /core\/removed; agents-config sync will drop/);
  assert.match(await readFile(manifestPath(home), 'utf8'), /core\/removed/);
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

test('a project install is recorded and removing it drops the record', async (t) => {
  const home = await tempDir(t);
  const project = await realpath(await tempDir(t));
  const install = ['init', '--project', project, '--yes', '--tools'];
  await cli(home, [...install, 'codex']);
  const recorded = await readFile(projectsPath(home), 'utf8');

  await cli(home, [...install, '']);

  assert.deepEqual(JSON.parse(recorded), { version: 1, projects: [project] });
  await assert.rejects(lstat(projectsPath(home)), { code: 'ENOENT' });
});

test('rejects an unknown skill mode', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, [...INSTALL, '--skill-mode', 'mirror']);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--skill-mode must be one of copy, link/);
});

test('rejects skills that are not in the catalog or skills/', async (t) => {
  const home = await tempDir(t);

  const result = await cli(home, [
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
  const home = await tempDir(t);
  const project = await tempDir(t);

  const result = await cli(home, [
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
  const home = await tempDir(t);

  const [updateResult, adoptResult, skillResult] = await Promise.all([
    cli(home, ['update', '--global']),
    cli(home, ['adopt', '--project', home]),
    cli(home, ['skill', 'unknown']),
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
  const home = await tempDir(t);

  const [badRuns, badThreshold, evalNoBaseline] = await Promise.all([
    cli(home, ['skill', 'eval', 'some-skill', '--runs', '0']),
    cli(home, ['skill', 'triggers', 'some-skill', '--threshold', 'not-num']),
    cli(home, [
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

test('init with --preset and lean style writes project seed, stack blocks, skills, and passes doctor', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);
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

  const initResult = await cli(home, [
    'init',
    '--project',
    project,
    '--preset',
    'nestjs-api',
    '--tools',
    'codex',
    '--yes',
  ]);
  const doctorResult = await cli(home, ['doctor', '--project', project]);
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
    'nestjs-module',
    'eslint-configuration',
    'prettier-configuration',
  ]);
});

test('init with --style self-contained includes engineering blocks and sync preserves edited seed preamble', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'standalone-service' }),
  );

  const initResult = await cli(home, [
    'init',
    '--project',
    project,
    '--preset',
    'node-tool',
    '--style',
    'self-contained',
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
  const syncResult = await cli(home, ['sync', '--project', project, '--yes']);
  const afterSync = await readFile(join(project, 'AGENTS.md'), 'utf8');

  assert.equal(initResult.code, 0);
  assert.equal(syncResult.code, 0);
  assert.match(
    afterSync,
    /Custom architecture notes preserved outside managed region\./,
  );
  assert.match(afterSync, /## Testing/);
  assert.match(afterSync, /## TypeScript/);
});

test('rejects invalid --preset or --style flags and rejects them on global installs', async (t) => {
  const home = await tempDir(t);
  const project = await tempDir(t);

  const [badPreset, badStyle, globalPreset, globalStyle] = await Promise.all([
    cli(home, ['init', '--project', project, '--preset', 'rails', '--yes']),
    cli(home, ['init', '--project', project, '--style', 'full', '--yes']),
    cli(home, [...INSTALL, '--preset', 'node-tool']),
    cli(home, [...INSTALL, '--style', 'lean']),
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
