import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { Context } from '../context.ts';
import type { Manifest } from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import { isolatedGitEnv } from '../test-support/git.ts';
import { setVariablesCommand } from './shared.ts';
import { collectChangeReports, findInstalledCopies } from './update-report.ts';

async function projectCommand(
  t: TestContext,
  dir: (home: string) => string,
): Promise<string> {
  const paths = await tempPaths(t);
  const ctx: Context = {
    paths,
    repoRoot: paths.home,
    cwd: paths.home,
    searchPath: [],
    interactive: false,
    sources: {
      url: () => 'file:///nowhere.git',
      env: isolatedGitEnv(paths.home),
      now: () => new Date(0),
    },
    print: () => {},
  };
  const project = dir(paths.home);
  return setVariablesCommand({
    ctx,
    location: {
      scope: 'project',
      manifestPath: join(project, '.agents', 'skills-wizard.json'),
      project: { dir: project, title: 'app' },
    },
    names: ['githubUsername'],
  });
}

test('setVariablesCommand leaves plain project paths unquoted', async (t) => {
  const command = await projectCommand(t, (home) => join(home, 'code', 'app'));

  assert.equal(
    command,
    'skills-wizard init --project ~/code/app --var githubUsername=<value>',
  );
});

test('setVariablesCommand quotes project paths for POSIX shells', async (t) => {
  const command = await projectCommand(t, (home) =>
    join(home, "my 'app' (copy)"),
  );

  assert.equal(
    command,
    "skills-wizard init --project ~/'my '\\''app'\\'' (copy)' --var githubUsername=<value>",
  );
});

test('setVariablesCommand quotes project paths outside the home directory', async (t) => {
  const command = await projectCommand(t, () => '/srv/my app;rm');

  assert.match(command, / --project '\/srv\/my app;rm' /);
});

test('collectChangeReports reports each distinct outdated copy across manifests', async (t) => {
  const root = await tempDir(t);
  const copyA = join(root, 'proj-a', '.agents', 'skills', 'notes');
  const copyB = join(root, 'proj-b', '.agents', 'skills', 'notes');
  const latest = join(root, 'latest', 'notes');
  await writeFiles(copyA, { 'SKILL.md': 'v1\n', 'only-a.md': 'a\n' });
  await writeFiles(copyB, { 'SKILL.md': 'v2\n', 'only-b.md': 'b\n' });
  await writeFiles(latest, { 'SKILL.md': 'v3\n' });

  const makeManifest = (
    path: string,
    hash: string,
    commit: string,
  ): Manifest => ({
    version: 1,
    scope: 'project',
    tools: ['codex'],
    blocks: [],
    skills: ['notes'],
    mcp: [],
    variables: {},
    options: {},
    entries: [
      {
        kind: 'skill',
        path,
        name: 'notes',
        source: { type: 'catalog', repo: 'org/skills', path: 'notes', commit },
        install: { mode: 'copy', hash },
      },
    ],
  });

  const manifests = [
    makeManifest(copyA, 'sha256:aaa', '1'.repeat(40)),
    makeManifest(copyB, 'sha256:bbb', '2'.repeat(40)),
  ];
  const source = {
    name: 'notes',
    dir: latest,
    hash: 'sha256:ccc',
    linkable: false,
    record: {
      type: 'catalog' as const,
      repo: 'org/skills',
      path: 'notes',
      commit: '3'.repeat(40),
    },
  };

  const copies = await findInstalledCopies(manifests, 'notes', source);
  assert.deepEqual(copies, [copyA, copyB]);

  const reports = await collectChangeReports(
    manifests,
    ['notes'],
    new Map([['notes', source]]),
  );
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0]?.diff.removed, ['only-a.md']);
  assert.deepEqual(reports[1]?.diff.removed, ['only-b.md']);
});
