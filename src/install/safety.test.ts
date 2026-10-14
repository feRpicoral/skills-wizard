import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApplyError, ManifestError } from '../errors.ts';
import { globalManifestPath } from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import {
  BEGIN,
  installGlobal,
  installProject,
  library,
  manifestOf,
  REPO,
  run,
  selection,
} from '../test-support/plan-fixtures.ts';
import { applyPlan } from './apply.ts';
import { buildPlan } from './plan.ts';

test('marks malformed managed regions as conflicts and leaves them untouched', async (t) => {
  const paths = await tempPaths(t);
  const broken = `${BEGIN}\none\n${BEGIN}\ntwo\n`;
  await writeFiles(paths.home, { '.claude/CLAUDE.md': broken });

  const plan = await installGlobal(paths, ['claude-code']);

  assert.equal(plan.actions[0]?.status, 'conflict');
  assert.equal(
    await readFile(join(paths.claudeHome, 'CLAUDE.md'), 'utf8'),
    broken,
  );
});

test('records only the actions that ran when an apply fails midway', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { '.claude': 'not a directory\n' });
  const manifestPath = globalManifestPath(paths);
  const plan = await buildPlan({
    scope: 'global',
    selection: selection(['antigravity', 'claude-code']),
    library,
    paths,
    repoRoot: REPO,
    previous: null,
    manifestPath,
  });

  await assert.rejects(applyPlan(plan), ApplyError);

  assert.deepEqual(
    (await manifestOf(paths))?.entries.map((entry) => entry.path),
    [join(paths.geminiHome, 'AGENTS.md')],
  );
});

test('project installs never write through links that leave the project', async (t) => {
  const paths = await tempPaths(t);
  const outside = await realpath(await tempDir(t));
  const dir = await realpath(await tempDir(t));
  await writeFiles(outside, { gitconfig: '[user]\n', zshrc: 'export A=1\n' });
  await symlink(join(outside, 'gitconfig'), join(dir, 'AGENTS.md'));
  await symlink(join(outside, 'zshrc'), join(dir, 'CLAUDE.md'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  assert.deepEqual(
    plan.actions.map((action) => action.status),
    ['conflict', 'conflict'],
  );
  assert.equal(await readFile(join(outside, 'gitconfig'), 'utf8'), '[user]\n');
  assert.equal(await readFile(join(outside, 'zshrc'), 'utf8'), 'export A=1\n');
});

test('project installs never write into a linked directory outside the project', async (t) => {
  const paths = await tempPaths(t);
  const outside = await realpath(await tempDir(t));
  const dir = await realpath(await tempDir(t));
  await symlink(outside, join(dir, '.gemini'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['gemini-cli'],
  });

  const settings = plan.actions.find(
    (action) => action.path === join(dir, '.gemini', 'settings.json'),
  );
  assert.equal(settings?.status, 'conflict');
  assert.deepEqual(await readdir(outside), []);
});

test('removing a project install leaves files behind links that leave the project', async (t) => {
  const paths = await tempPaths(t);
  const outside = await realpath(await tempDir(t));
  const dir = await realpath(await tempDir(t));
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });
  await writeFiles(outside, { zshrc: '@AGENTS.md\n\nexport A=1\n' });
  await rm(join(dir, 'CLAUDE.md'));
  await symlink(join(outside, 'zshrc'), join(dir, 'CLAUDE.md'));

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: [],
  });

  assert.equal(
    await readFile(join(outside, 'zshrc'), 'utf8'),
    '@AGENTS.md\n\nexport A=1\n',
  );
});

test('a project whose manifest directory links outside the project is refused', async (t) => {
  const paths = await tempPaths(t);
  const outside = await realpath(await tempDir(t));
  const dir = await realpath(await tempDir(t));
  await symlink(outside, join(dir, '.agents'));

  await assert.rejects(
    installProject({
      paths,
      project: { dir, title: 'app' },
      tools: ['codex'],
    }),
    ManifestError,
  );

  assert.deepEqual(await readdir(outside), []);
});

test('a directory where an instructions file belongs is a conflict', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(join(paths.codexHome, 'AGENTS.md'), { recursive: true });

  const plan = await installGlobal(paths, ['codex']);

  assert.equal(plan.actions[0]?.status, 'conflict');
  assert.equal(plan.actions[0]?.reason, 'is a directory');
});

test('a dangling link on the way to a target is a conflict', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await symlink(join(dir, 'missing'), join(dir, '.gemini'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['gemini-cli'],
  });

  const settings = plan.actions.find(
    (action) => action.path === join(dir, '.gemini', 'settings.json'),
  );
  assert.equal(settings?.status, 'conflict');
  assert.equal(settings?.reason, 'links to a missing location, left in place');
});

test('a manifest directory that is a dangling link stops before any write', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await symlink(join(dir, 'missing'), join(dir, '.agents'));

  await assert.rejects(
    installProject({
      paths,
      project: { dir, title: 'app' },
      tools: ['codex'],
    }),
    /links to a missing location/,
  );

  await assert.rejects(lstat(join(dir, 'AGENTS.md')), { code: 'ENOENT' });
});

test('a symlinked manifest stops the install before any write', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    'dotfiles/manifest.json': JSON.stringify({
      version: 1,
      scope: 'global',
      tools: [],
      blocks: [],
      variables: {},
      entries: [],
    }),
  });
  await mkdir(paths.stateDir, { recursive: true });
  await symlink(
    join(paths.home, 'dotfiles', 'manifest.json'),
    globalManifestPath(paths),
  );

  await assert.rejects(installGlobal(paths, ['copilot']), /is a symlink/);

  await assert.rejects(lstat(paths.copilotHome), { code: 'ENOENT' });
});

test('a target that is not a regular file is a conflict', async (t) => {
  const paths = await tempPaths(t);
  await mkdir(paths.codexHome, { recursive: true });
  await run('mkfifo', [join(paths.codexHome, 'AGENTS.md')]);

  const plan = await installGlobal(paths, ['codex']);

  assert.equal(plan.actions[0]?.status, 'conflict');
  assert.equal(plan.actions[0]?.reason, 'is not a regular file');
});

test('a manifest that cannot be written names the changes it could not record', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.agents/skills-wizard': 'not a directory\n',
  });

  await assert.rejects(installGlobal(paths, ['copilot']), {
    name: 'ApplyError',
    message: /changed but not recorded: .*copilot-instructions\.md/,
  });
});
