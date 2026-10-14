import assert from 'node:assert/strict';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { UsageError } from '../errors.ts';
import {
  addRecordedBlock,
  clearRecordedVariables,
  commandSandbox,
  manifestPath,
  projectManifestPath,
  run,
} from '../test-support/command-fixtures.ts';
import { tempDir } from '../test-support/fixtures.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { runSync } from './sync.ts';

test('sync reapplies a recorded install after a file was edited', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'edited\n');

  const doctorRun = createCtx();
  await runDoctor(doctorRun.ctx, { scope: 'global' });
  const syncRun = createCtx();
  const code = await runSync(syncRun.ctx, {
    scope: 'global',
    yes: true,
    dryRun: false,
  });

  assert.match(doctorRun.output(), /out of date/);
  assert.equal(code, 0);
  assert.match(syncRun.output(), /update\s+~\/\.codex\/AGENTS\.md/);
});

test('sync drops recorded blocks that left the library and still applies', async (t) => {
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
  const code = await runSync(ctx, {
    scope: 'global',
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /no longer in the library.*core\/removed/);
  assert.doesNotMatch(
    await readFile(manifestPath(home), 'utf8'),
    /core\/removed/,
  );
});

test('sync stops with the init command when a block gains a variable it cannot look up', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await clearRecordedVariables(manifestPath(home));

  await assert.rejects(
    runSync(createCtx().ctx, { scope: 'global', yes: true, dryRun: false }),
    (error: unknown) =>
      error instanceof UsageError &&
      /githubUsername.*agents-config init --global --var githubUsername=<value>/.test(
        error.message,
      ),
  );
});

test('sync looks up a variable a block gained and records it', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await clearRecordedVariables(manifestPath(home));
  await writeFile(join(home, '.gitconfig'), '[github]\n\tuser = hubot\n');

  const { ctx, output } = createCtx();
  const code = await runSync(ctx, {
    scope: 'global',
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /githubUsername=hubot/);
  assert.match(
    await readFile(manifestPath(home), 'utf8'),
    /"githubUsername": "hubot"/,
  );
});

test('sync drops recorded blocks that are no longer available for the scope', async (t) => {
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
  const code = await runSync(ctx, {
    scope: 'project',
    projectDir: project,
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(
    output(),
    /no longer available for project scope.*core\/identity/,
  );
  assert.doesNotMatch(
    await readFile(projectManifestPath(project), 'utf8'),
    /core\/identity/,
  );
});

test('sync without a recorded install is a usage error', async (t) => {
  const { createCtx } = await commandSandbox(t);

  await assert.rejects(
    runSync(createCtx().ctx, { scope: 'global', yes: true, dryRun: false }),
    (error: unknown) =>
      error instanceof UsageError &&
      /run agents-config init first/.test(error.message),
  );
});

test('a keep-local project copied into another repository still syncs', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const repo = await tempDir(t);
  const other = await tempDir(t);
  const copy = join(other, 'app');
  await run('git', ['init', '-q'], { cwd: repo });
  await run('git', ['init', '-q'], { cwd: other });
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: repo,
    tools: ['codex'],
    variables: {},
    keepLocal: true,
    yes: true,
    dryRun: false,
  });
  await cp(join(repo, '.agents'), join(copy, '.agents'), { recursive: true });

  const { ctx, output } = createCtx();
  const code = await runSync(ctx, {
    scope: 'project',
    projectDir: copy,
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /belong to another repository/);
});

test('sync drops keep-local with a notice once the project leaves git', async (t) => {
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
  const code = await runSync(ctx, {
    scope: 'project',
    projectDir: project,
    yes: true,
    dryRun: false,
  });

  assert.equal(code, 0);
  assert.match(output(), /no longer in a git repository/);
  assert.doesNotMatch(output(), /another repository/);
});
