import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import {
  BEGIN,
  END,
  installProject,
  projectEntries,
} from '../test-support/plan-fixtures.ts';

test('a CLAUDE.md that links to AGENTS.md needs no import line', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': '# Team\n' });
  await symlink('AGENTS.md', join(dir, 'CLAUDE.md'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  const claude = plan.actions.find(
    (action) => action.path === join(dir, 'CLAUDE.md'),
  );
  assert.equal(claude?.status, 'unchanged');
  assert.equal(claude?.entry, null);
  assert.ok((await lstat(join(dir, 'CLAUDE.md'))).isSymbolicLink());
});

test('an import line satisfied by a CLAUDE.md link says it links to AGENTS.md', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': '# Team\n' });
  await symlink('AGENTS.md', join(dir, 'CLAUDE.md'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  assert.equal(
    plan.actions.find((action) => action.path === join(dir, 'CLAUDE.md'))
      ?.label,
    'Claude Code import (links to AGENTS.md)',
  );
});

test('an AGENTS.md that links to CLAUDE.md gets the region and no self-import', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'CLAUDE.md': '# Team\n' });
  await symlink('CLAUDE.md', join(dir, 'AGENTS.md'));

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  assert.deepEqual(
    {
      content: await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
      entries: await projectEntries(dir),
    },
    {
      content: `# Team\n\n${BEGIN}\n## Style\n\nBe direct.\n${END}\n`,
      entries: [
        { kind: 'region', path: join(dir, 'AGENTS.md'), createdFile: false },
      ],
    },
  );
});

test('an import line satisfied by an AGENTS.md link says which way the link points', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'CLAUDE.md': '# Team\n' });
  await symlink('CLAUDE.md', join(dir, 'AGENTS.md'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  assert.equal(
    plan.actions.find((action) => action.path === join(dir, 'CLAUDE.md'))
      ?.label,
    'Claude Code import (AGENTS.md links here)',
  );
});

test('removing an install from an AGENTS.md that links to CLAUDE.md leaves no region', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'CLAUDE.md': '# Team\n' });
  await symlink('CLAUDE.md', join(dir, 'AGENTS.md'));
  for (let round = 0; round < 2; round += 1) {
    await installProject({
      paths,
      project: { dir, title: 'app' },
      tools: ['claude-code'],
    });
  }

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: [],
  });

  assert.deepEqual(
    {
      content: await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
      entries: await projectEntries(dir),
    },
    { content: '# Team\n', entries: null },
  );
});

test('a self-import added before AGENTS.md became a link is removed with the region kept', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'CLAUDE.md': '# Team\n' });
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });
  await rm(join(dir, 'AGENTS.md'));
  await symlink('CLAUDE.md', join(dir, 'AGENTS.md'));

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  assert.deepEqual(
    {
      content: await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
      entries: await projectEntries(dir),
    },
    {
      content: `# Team\n\n${BEGIN}\n## Style\n\nBe direct.\n${END}\n`,
      entries: [
        { kind: 'region', path: join(dir, 'AGENTS.md'), createdFile: false },
      ],
    },
  );
});

async function relinkCreatedInstructions(dir: string): Promise<string> {
  const moved = join(dir, 'docs', 'AGENTS.md');
  await mkdir(join(dir, 'docs'));
  await rename(join(dir, 'AGENTS.md'), moved);
  await symlink(join('docs', 'AGENTS.md'), join(dir, 'AGENTS.md'));
  return moved;
}

test('a created AGENTS.md later reached through a link keeps its heading on removal', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['codex'],
  });
  const moved = await relinkCreatedInstructions(dir);

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: [],
  });

  assert.equal(await readFile(moved, 'utf8'), '# app\n');
});

test('a blank AGENTS.md reached through a link gets no heading and is left empty', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'docs/AGENTS.md': '' });
  await symlink(join('docs', 'AGENTS.md'), join(dir, 'AGENTS.md'));
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['codex'],
  });
  const installed = await readFile(join(dir, 'docs', 'AGENTS.md'), 'utf8');

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: [],
  });

  assert.doesNotMatch(installed, /^# app/);
  assert.equal(await readFile(join(dir, 'docs', 'AGENTS.md'), 'utf8'), '');
});

test('a created AGENTS.md synced through a link keeps its heading on removal', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['codex'],
  });
  const moved = await relinkCreatedInstructions(dir);
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['codex'],
  });

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: [],
  });

  assert.equal(await readFile(moved, 'utf8'), '# app\n');
});

test('a CLAUDE.md link to an AGENTS.md that does not exist yet needs no import line', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await symlink('AGENTS.md', join(dir, 'CLAUDE.md'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  const claude = plan.actions.find(
    (action) => action.path === join(dir, 'CLAUDE.md'),
  );
  assert.equal(claude?.status, 'unchanged');
  assert.match(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), /^# app\n/);
});
