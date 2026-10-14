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

import { projectManifestPath } from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import {
  BEGIN,
  END,
  gitProject,
  installProject,
  projectEntries,
  run,
} from '../test-support/plan-fixtures.ts';

test('project installs append after existing regions and prepend the import line', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, {
    'AGENTS.md':
      '<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n',
    'CLAUDE.md': '# Claude only\n',
  });

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code', 'gemini-cli'],
  });

  assert.equal(
    await readFile(join(dir, 'AGENTS.md'), 'utf8'),
    `<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n\n${BEGIN}\n## Style\n\nBe direct.\n${END}\n`,
  );
  assert.equal(
    await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
    '@AGENTS.md\n\n# Claude only\n',
  );
});

test('an import line that already existed is kept when Claude Code is deselected', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'CLAUDE.md': '@AGENTS.md\n' });
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
  });

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['gemini-cli'],
  });

  const claude = plan.actions.find(
    (action) => action.path === join(dir, 'CLAUDE.md'),
  );
  assert.equal(claude?.status, 'unchanged');
  assert.equal(claude?.reason, 'the line was there before agents-config');
  assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
});

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

test('removing a project install deletes the files it created', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code', 'gemini-cli'],
  });

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: [],
  });

  await assert.rejects(lstat(join(dir, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(dir, 'CLAUDE.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(projectManifestPath(dir)), { code: 'ENOENT' });
});

test('keep-local patterns are relative to the repository root, one region per project', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const app = await gitProject({ root, subdir: 'packages/app' });
  const web = await gitProject({ root, subdir: 'packages/web' });

  await installProject({
    paths,
    project: app,
    tools: ['codex'],
    overrides: { keepLocal: true },
  });
  await installProject({
    paths,
    project: web,
    tools: ['codex'],
    overrides: { keepLocal: true },
  });

  const exclude = await readFile(
    join(app.git?.root ?? '', '.git', 'info', 'exclude'),
    'utf8',
  );
  assert.match(
    exclude,
    /# BEGIN:agents-config packages\/app\n\/packages\/app\/AGENTS\.md\n\/packages\/app\/\.agents\/agents-config\.json\n# END:agents-config packages\/app/,
  );
  assert.match(
    exclude,
    /# BEGIN:agents-config packages\/web\n\/packages\/web\/AGENTS\.md/,
  );
});

async function isIgnored(root: string, path: string): Promise<boolean> {
  try {
    await run('git', ['check-ignore', '-q', path], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

test('keep-local patterns match paths with gitignore metacharacters literally', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const app = await gitProject({ root, subdir: 'packages/[app]*?' });

  await installProject({
    paths,
    project: app,
    tools: ['codex'],
    overrides: { keepLocal: true },
  });

  assert.deepEqual(
    {
      target: await isIgnored(root, 'packages/[app]*?/AGENTS.md'),
      sibling: await isIgnored(root, 'packages/pp/AGENTS.md'),
    },
    { target: true, sibling: false },
  );
});

test('a project file recreated after deletion is removed with its heading', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': '# Team\n' });
  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['codex'],
  });
  await rm(join(dir, 'AGENTS.md'));
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

  await assert.rejects(lstat(join(dir, 'AGENTS.md')), { code: 'ENOENT' });
});

test('a blank AGENTS.md that existed is left empty once the install is removed', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': ' \n' });
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

  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '');
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
