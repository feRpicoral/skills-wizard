import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { BlockLibrary } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { ApplyError, ManifestError } from '../errors.ts';
import {
  globalManifestPath,
  type Manifest,
  projectManifestPath,
  readManifest,
} from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import type { ToolId } from '../tools/registry.ts';
import { applyPlan } from './apply.ts';
import {
  buildPlan,
  type Plan,
  type ProjectContext,
  type Selection,
} from './plan.ts';

const run = promisify(execFile);
const BEGIN = '<!-- BEGIN:agents-config -->';
const END = '<!-- END:agents-config -->';
const REPO = '/repo';

const library: BlockLibrary = {
  headers: { global: '# Rules' },
  groups: { core: 'Core' },
  blocks: [
    {
      id: 'core/identity',
      group: 'core',
      title: 'Identity',
      summary: 'Identity',
      scopes: ['global'],
      defaults: ['global'],
      variables: ['githubUsername'],
      requires: [],
      body: 'GitHub username: {{githubUsername}}',
    },
    {
      id: 'core/style',
      group: 'core',
      title: 'Style',
      summary: 'Style',
      scopes: ['global', 'project'],
      defaults: ['global', 'project'],
      variables: [],
      requires: [],
      body: '## Style\n\nBe direct.',
    },
  ],
};

function selection(
  tools: ToolId[],
  overrides: Partial<Selection> = {},
): Selection {
  return {
    tools,
    blocks: ['core/identity', 'core/style'],
    variables: { githubUsername: 'octocat' },
    linkCommand: false,
    keepLocal: false,
    ...overrides,
  };
}

async function installGlobal(
  paths: Paths,
  tools: ToolId[],
  overrides: Partial<Selection> = {},
): Promise<Plan> {
  const manifestPath = globalManifestPath(paths);
  const plan = await buildPlan({
    scope: 'global',
    selection: selection(tools, overrides),
    library,
    paths,
    repoRoot: REPO,
    previous: await readManifest(manifestPath),
    manifestPath,
  });
  await applyPlan(plan);
  return plan;
}

async function installProject(
  paths: Paths,
  project: ProjectContext,
  tools: ToolId[],
  overrides: Partial<Selection> = {},
): Promise<Plan> {
  const manifestPath = projectManifestPath(project.dir);
  const previous = await readManifest(manifestPath, {
    dir: project.dir,
    ...(project.git ? { gitExcludePath: project.git.excludePath } : {}),
  });
  const plan = await buildPlan({
    scope: 'project',
    selection: selection(tools, {
      blocks: ['core/style'],
      variables: {},
      ...overrides,
    }),
    library,
    paths,
    repoRoot: REPO,
    previous,
    manifestPath,
    project,
  });
  await applyPlan(plan);
  return plan;
}

async function manifestOf(paths: Paths): Promise<Manifest | null> {
  return readManifest(globalManifestPath(paths));
}

async function gitProject(root: string, subdir = ''): Promise<ProjectContext> {
  await run('git', ['init', '-q'], { cwd: root });
  const realRoot = await realpath(root);
  const dir = join(realRoot, subdir);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    title: 'app',
    git: {
      root: realRoot,
      excludePath: join(realRoot, '.git', 'info', 'exclude'),
    },
  };
}

test('writes one shared Gemini file plus tool-specific files', async (t) => {
  const paths = await tempPaths(t);

  const plan = await installGlobal(paths, [
    'antigravity',
    'gemini-cli',
    'claude-code',
  ]);

  assert.deepEqual(
    plan.actions.map((action) => [action.path, action.status]),
    [
      [join(paths.geminiHome, 'AGENTS.md'), 'create'],
      [join(paths.claudeHome, 'CLAUDE.md'), 'create'],
      [join(paths.geminiHome, 'settings.json'), 'create'],
    ],
  );
  assert.equal(
    await readFile(join(paths.geminiHome, 'AGENTS.md'), 'utf8'),
    `${BEGIN}\n# Rules\n\nGitHub username: octocat\n\n## Style\n\nBe direct.\n${END}\n`,
  );
});

test('a second run plans nothing, including the manifest', async (t) => {
  const paths = await tempPaths(t);
  await installGlobal(paths, ['claude-code', 'gemini-cli']);

  const manifestPath = globalManifestPath(paths);
  const plan = await buildPlan({
    scope: 'global',
    selection: selection(['claude-code', 'gemini-cli']),
    library,
    paths,
    repoRoot: REPO,
    previous: await readManifest(manifestPath),
    manifestPath,
  });

  assert.ok(plan.actions.every((action) => action.status === 'unchanged'));
  assert.equal(plan.manifestStatus, 'unchanged');
});

test('deselecting tools removes only the content agents-config added', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.claude/CLAUDE.md': '# Mine\n',
    '.gemini/settings.json': '{"theme":"dark"}\n',
  });
  await installGlobal(paths, ['claude-code', 'gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.claudeHome, 'CLAUDE.md'), 'utf8'),
    '# Mine\n',
  );
  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    '{\n  "theme": "dark"\n}\n',
  );
  await assert.rejects(lstat(join(paths.geminiHome, 'AGENTS.md')), {
    code: 'ENOENT',
  });
});

test('deselecting Gemini CLI restores a string context file name', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.gemini/settings.json':
      '{\n    "context": { "fileName": "GEMINI.md" }\n}\n',
  });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    '{\n    "context": {\n        "fileName": "GEMINI.md"\n    }\n}\n',
  );
});

test('keeps the shared Gemini file while another tool still uses it', async (t) => {
  const paths = await tempPaths(t);
  await installGlobal(paths, ['antigravity', 'gemini-cli']);

  const plan = await installGlobal(paths, ['antigravity']);

  const shared = plan.actions.find(
    (action) => action.path === join(paths.geminiHome, 'AGENTS.md'),
  );
  assert.equal(shared?.status, 'unchanged');
});

test('writes through a symlinked instructions file and keeps the link', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { 'dotfiles/CLAUDE.md': '# Mine\n' });
  await mkdir(paths.claudeHome, { recursive: true });
  const real = await realpath(join(paths.home, 'dotfiles', 'CLAUDE.md'));
  await symlink(real, join(paths.claudeHome, 'CLAUDE.md'));

  const plan = await installGlobal(paths, ['claude-code']);

  assert.equal(plan.actions[0]?.writePath, real);
  assert.ok(
    (await lstat(join(paths.claudeHome, 'CLAUDE.md'))).isSymbolicLink(),
  );
  assert.match(
    await readFile(real, 'utf8'),
    /^# Mine\n\n<!-- BEGIN:agents-config -->/,
  );
});

test('never replaces an unmanaged file at the command link path', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { '.local/bin/agents-config': 'mine\n' });

  const plan = await installGlobal(paths, ['codex'], { linkCommand: true });

  const link = plan.actions.find(
    (action) => action.label === 'agents-config command',
  );
  assert.equal(link?.status, 'conflict');
  assert.equal(
    await readFile(join(paths.localBin, 'agents-config'), 'utf8'),
    'mine\n',
  );
});

test('links the command and removes the link once deselected', async (t) => {
  const paths = await tempPaths(t);
  const link = join(paths.localBin, 'agents-config');
  await installGlobal(paths, ['codex'], { linkCommand: true });

  await installGlobal(paths, ['codex'], { linkCommand: false });

  await assert.rejects(lstat(link), { code: 'ENOENT' });
});

test('a still selected link that was retargeted is left alone', async (t) => {
  const paths = await tempPaths(t);
  const link = join(paths.localBin, 'agents-config');
  await installGlobal(paths, ['codex'], { linkCommand: true });
  await rm(link);
  await symlink('/elsewhere/cli', link);

  const plan = await installGlobal(paths, ['codex'], { linkCommand: true });

  const action = plan.actions.find((entry) => entry.path === link);
  assert.equal(action?.status, 'conflict');
  assert.equal(await readlink(link), '/elsewhere/cli');
});

test('a still selected link replaced by a file is left alone', async (t) => {
  const paths = await tempPaths(t);
  const link = join(paths.localBin, 'agents-config');
  await installGlobal(paths, ['codex'], { linkCommand: true });
  await rm(link);
  await writeFiles(paths.home, { '.local/bin/agents-config': 'mine\n' });

  await installGlobal(paths, ['codex'], { linkCommand: true });

  assert.equal(await readFile(link, 'utf8'), 'mine\n');
});

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

test('project installs append after existing regions and prepend the import line', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, {
    'AGENTS.md':
      '<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n',
    'CLAUDE.md': '# Claude only\n',
  });

  await installProject(paths, { dir, title: 'app' }, [
    'claude-code',
    'gemini-cli',
  ]);

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
  await installProject(paths, { dir, title: 'app' }, ['claude-code']);

  const plan = await installProject(paths, { dir, title: 'app' }, [
    'gemini-cli',
  ]);

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

  const plan = await installProject(paths, { dir, title: 'app' }, [
    'claude-code',
  ]);

  const claude = plan.actions.find(
    (action) => action.path === join(dir, 'CLAUDE.md'),
  );
  assert.equal(claude?.status, 'unchanged');
  assert.equal(claude?.entry, null);
  assert.ok((await lstat(join(dir, 'CLAUDE.md'))).isSymbolicLink());
});

test('removing a project install deletes the files it created', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await installProject(paths, { dir, title: 'app' }, [
    'claude-code',
    'gemini-cli',
  ]);

  await installProject(paths, { dir, title: 'app' }, []);

  await assert.rejects(lstat(join(dir, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(dir, 'CLAUDE.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(projectManifestPath(dir)), { code: 'ENOENT' });
});

test('keep-local patterns are relative to the repository root, one region per project', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const app = await gitProject(root, 'packages/app');
  const web = await gitProject(root, 'packages/web');

  await installProject(paths, app, ['codex'], { keepLocal: true });
  await installProject(paths, web, ['codex'], { keepLocal: true });

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

test('project installs never write through links that leave the project', async (t) => {
  const paths = await tempPaths(t);
  const outside = await realpath(await tempDir(t));
  const dir = await realpath(await tempDir(t));
  await writeFiles(outside, { gitconfig: '[user]\n', zshrc: 'export A=1\n' });
  await symlink(join(outside, 'gitconfig'), join(dir, 'AGENTS.md'));
  await symlink(join(outside, 'zshrc'), join(dir, 'CLAUDE.md'));

  const plan = await installProject(paths, { dir, title: 'app' }, [
    'claude-code',
  ]);

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

  const plan = await installProject(paths, { dir, title: 'app' }, [
    'gemini-cli',
  ]);

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
  await installProject(paths, { dir, title: 'app' }, ['claude-code']);
  await writeFiles(outside, { zshrc: '@AGENTS.md\n\nexport A=1\n' });
  await rm(join(dir, 'CLAUDE.md'));
  await symlink(join(outside, 'zshrc'), join(dir, 'CLAUDE.md'));

  await installProject(paths, { dir, title: 'app' }, []);

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
    installProject(paths, { dir, title: 'app' }, ['codex']),
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

test('a project file recreated after deletion is removed with its heading', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'AGENTS.md': '# Team\n' });
  await installProject(paths, { dir, title: 'app' }, ['codex']);
  await rm(join(dir, 'AGENTS.md'));
  await installProject(paths, { dir, title: 'app' }, ['codex']);

  await installProject(paths, { dir, title: 'app' }, []);

  await assert.rejects(lstat(join(dir, 'AGENTS.md')), { code: 'ENOENT' });
});

test('a CLAUDE.md link to an AGENTS.md that does not exist yet needs no import line', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await symlink('AGENTS.md', join(dir, 'CLAUDE.md'));

  const plan = await installProject(paths, { dir, title: 'app' }, [
    'claude-code',
  ]);

  const claude = plan.actions.find(
    (action) => action.path === join(dir, 'CLAUDE.md'),
  );
  assert.equal(claude?.status, 'unchanged');
  assert.match(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), /^# app\n/);
});
