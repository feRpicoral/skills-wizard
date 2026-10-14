import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { commandOutput } from '../blocks/variables.ts';
import { projectManifestPath } from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import {
  BEGIN,
  END,
  gitProject,
  installProject,
  library,
  run,
} from '../test-support/plan-fixtures.ts';
import { displayPath } from './describe.ts';
import { buildPlan } from './plan.ts';

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

test('keep-local marks a conflict instead of crashing buildPlan when a relative path contains a newline', async (t) => {
  const paths = await tempPaths(t);
  const root = await realpath(await tempDir(t));
  const excludePath = join(root, '.git', 'info', 'exclude');
  const projectDir = join(root, 'packages', 'bad\nname');
  await mkdir(projectDir, { recursive: true });

  const plan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['codex'],
      blocks: ['core/style'],
      variables: {},
      linkCommand: false,
      keepLocal: true,
    },
    library,
    paths,
    repoRoot: root,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: {
      dir: projectDir,
      title: 'app',
      git: { root, excludePath },
    },
  });

  const excludeAction = plan.actions.find(
    (action) => action.path === excludePath,
  );
  assert.equal(excludeAction?.status, 'conflict');
  assert.match(excludeAction?.reason ?? '', /must not contain line breaks/);
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

test('displayPath normalizes home directories with trailing slashes and commandOutput preserves process.env', async () => {
  assert.equal(
    displayPath({ path: '/Users/me/.claude/CLAUDE.md', home: '/Users/me/' }),
    '~/.claude/CLAUDE.md',
  );
  assert.equal(displayPath({ path: '/Users/me', home: '/Users/me/' }), '~');

  const prev = process.env.AGENTS_CONFIG_TEST_VAR;
  process.env.AGENTS_CONFIG_TEST_VAR = 'preserved-from-process-env';
  try {
    const out = await commandOutput(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.AGENTS_CONFIG_TEST_VAR ?? "")'],
      { home: '/tmp' },
    );
    assert.equal(out, 'preserved-from-process-env');
  } finally {
    if (prev === undefined) delete process.env.AGENTS_CONFIG_TEST_VAR;
    else process.env.AGENTS_CONFIG_TEST_VAR = prev;
  }
});
