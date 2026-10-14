import assert from 'node:assert/strict';
import { lstat, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  addRecordedBlock,
  commandSandbox,
  manifestPath,
  projectManifestPath,
  run,
} from '../test-support/command-fixtures.ts';
import { tempDir } from '../test-support/fixtures.ts';
import { runInit } from './init.ts';

function projectsPath(home: string): string {
  return join(home, '.agents', 'agents-config', 'projects.json');
}

test('init --dry-run prints the plan and writes nothing', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  const { ctx, output } = createCtx();

  const code = await runInit(ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: true,
  });

  assert.equal(code, 0);
  assert.match(output(), /create\s+~\/\.codex\/AGENTS\.md/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init without a terminal and without --yes writes nothing', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  const { ctx, output } = createCtx();

  const code = await runInit(ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: false,
    dryRun: false,
  });

  assert.equal(code, 1);
  assert.match(output(), /Re-run with --yes/);
  await assert.rejects(lstat(join(home, '.codex')), { code: 'ENOENT' });
});

test('init warns when ~/.local/bin is not on PATH after linking the command', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { ctx, output } = createCtx();

  const code = await runInit(ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    linkCommand: true,
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /\.local\/bin is not on your PATH/);
});

test('init accepts ~/.local/bin on PATH written with a trailing slash', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  const { ctx, output } = createCtx({
    extraPath: `${join(home, '.local', 'bin')}/`,
  });

  const code = await runInit(ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    linkCommand: true,
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.doesNotMatch(output(), /not on your PATH/);
});

test('an empty tool list removes everything that was installed', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });

  const code = await runInit(createCtx().ctx, {
    scope: 'global',
    tools: [],
    variables: {},
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  await assert.rejects(lstat(join(home, '.codex', 'AGENTS.md')), {
    code: 'ENOENT',
  });
  await assert.rejects(lstat(manifestPath(home)), { code: 'ENOENT' });
});

test('init drops recorded blocks that left the library and still installs', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const { ctx, output } = createCtx();
  const code = await runInit(ctx, {
    scope: 'global',
    variables: {},
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /no longer in the library.*core\/removed/);
});

test('init drops recorded blocks that are no longer available for the scope', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const project = await tempDir(t);
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const { ctx, output } = createCtx();
  const code = await runInit(ctx, {
    scope: 'project',
    projectDir: project,
    variables: {},
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(
    output(),
    /no longer available for project scope.*core\/identity/,
  );
});

test('a package.json that links outside the project is not read for the title', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const project = await tempDir(t);
  await symlink('/dev/zero', join(project, 'package.json'));

  const code = await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(
    await readFile(join(project, 'AGENTS.md'), 'utf8'),
    new RegExp(`^# ${basename(project)}\n`),
  );
});

test('init drops keep-local with a notice once the project leaves git', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const project = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: project });
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    keepLocal: true,
    yes: true,
    dryRun: false,
  });
  await rm(join(project, '.git'), { recursive: true, force: true });

  const { ctx, output } = createCtx();
  const code = await runInit(ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /no longer in a git repository/);
  assert.match(
    await readFile(join(project, '.agents', 'agents-config.json'), 'utf8'),
    /"keepLocal": false/,
  );
});

test('a project install is recorded and removing it drops the record', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  const project = await realpath(await tempDir(t));
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  const recorded = await readFile(projectsPath(home), 'utf8');

  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: [],
    variables: {},
    yes: true,
    dryRun: false,
  });

  assert.deepEqual(JSON.parse(recorded), { version: 1, projects: [project] });
  await assert.rejects(lstat(projectsPath(home)), { code: 'ENOENT' });
});
