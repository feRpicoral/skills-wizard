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
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { BlockLibrary } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { ApplyError, ManifestError } from '../errors.ts';
import {
  globalManifestPath,
  type Manifest,
  type ManifestEntry,
  projectManifestPath,
  readManifest,
  readProjectManifest,
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

interface InstallProjectParams {
  paths: Paths;
  project: ProjectContext;
  tools: ToolId[];
  overrides?: Partial<Selection>;
}

async function installProject({
  paths,
  project,
  tools,
  overrides = {},
}: InstallProjectParams): Promise<Plan> {
  const manifestPath = projectManifestPath(project.dir);
  const stored = await readProjectManifest(manifestPath, {
    dir: project.dir,
    ...(project.git ? { gitExcludePath: project.git.excludePath } : {}),
  });
  const previous = stored?.manifest ?? null;
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

async function projectEntries(dir: string): Promise<ManifestEntry[] | null> {
  const stored = await readProjectManifest(projectManifestPath(dir), { dir });
  return stored?.manifest.entries ?? null;
}

interface GitProjectParams {
  root: string;
  subdir?: string;
}

async function gitProject({
  root,
  subdir = '',
}: GitProjectParams): Promise<ProjectContext> {
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
    '{"theme":"dark"}\n',
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
    '{\n    "context": { "fileName": "GEMINI.md" }\n}\n',
  );
});

test('deselecting Gemini CLI keeps other settings and parents as written', async (t) => {
  const paths = await tempPaths(t);
  const settings =
    '{\n  "ratio": 1.0,\n  "mcpServers": { "gh": { "command": "gh", "args": ["mcp"] } },\n  "context": {}\n}\n';
  await writeFiles(paths.home, { '.gemini/settings.json': settings });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    settings,
  );
});

async function legacySettingsInstall(paths: Paths): Promise<string> {
  const settings = join(paths.geminiHome, 'settings.json');
  await writeFiles(paths.home, {
    '.gemini/settings.json':
      '{\n  "context": {\n    "fileName": [\n      "AGENTS.md",\n      "GEMINI.md"\n    ]\n  }\n}\n',
    [relative(paths.home, globalManifestPath(paths))]: JSON.stringify({
      version: 1,
      scope: 'global',
      tools: ['gemini-cli'],
      blocks: [],
      variables: {},
      entries: [
        {
          kind: 'json-array',
          path: settings,
          key: 'context.fileName',
          added: ['AGENTS.md', 'GEMINI.md'],
          wasString: false,
          createdFile: true,
        },
      ],
    }),
  });
  return settings;
}

test('a settings file created before parents were recorded is deleted on removal', async (t) => {
  const paths = await tempPaths(t);
  const settings = await legacySettingsInstall(paths);

  await installGlobal(paths, []);

  await assert.rejects(lstat(settings), { code: 'ENOENT' });
});

test('a sync keeps an unrecorded parent count unknown instead of guessing', async (t) => {
  const paths = await tempPaths(t);
  const settings = await legacySettingsInstall(paths);
  await installGlobal(paths, ['gemini-cli']);

  await installGlobal(paths, []);

  await assert.rejects(lstat(settings), { code: 'ENOENT' });
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

async function linkedDotfile(paths: Paths): Promise<string> {
  await writeFiles(paths.home, { 'dotfiles/AGENTS.md': '# Mine\n' });
  const real = await realpath(join(paths.home, 'dotfiles', 'AGENTS.md'));
  await mkdir(paths.claudeHome, { recursive: true });
  await mkdir(paths.codexHome, { recursive: true });
  await symlink(real, join(paths.claudeHome, 'CLAUDE.md'));
  await symlink(real, join(paths.codexHome, 'AGENTS.md'));
  return real;
}

test('two linked instructions files that share one real file get one region', async (t) => {
  const paths = await tempPaths(t);
  const real = await linkedDotfile(paths);

  const plan = await installGlobal(paths, ['claude-code', 'codex']);

  assert.deepEqual(
    {
      content: await readFile(real, 'utf8'),
      changes: plan.actions.map((action) => action.change.type),
      entries: (await manifestOf(paths))?.entries,
    },
    {
      content: `# Mine\n\n${BEGIN}\n# Rules\n\nGitHub username: octocat\n\n## Style\n\nBe direct.\n${END}\n`,
      changes: ['write', 'none'],
      entries: [
        {
          kind: 'region',
          path: join(paths.claudeHome, 'CLAUDE.md'),
          createdFile: false,
        },
        {
          kind: 'region',
          path: join(paths.codexHome, 'AGENTS.md'),
          createdFile: false,
        },
      ],
    },
  );
});

test('a real file shared through links keeps its region while a tool still uses it', async (t) => {
  const paths = await tempPaths(t);
  const real = await linkedDotfile(paths);
  await installGlobal(paths, ['claude-code', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.deepEqual(
    {
      hasRegion: (await readFile(real, 'utf8')).includes(BEGIN),
      entries: (await manifestOf(paths))?.entries,
    },
    {
      hasRegion: true,
      entries: [
        {
          kind: 'region',
          path: join(paths.codexHome, 'AGENTS.md'),
          createdFile: false,
        },
      ],
    },
  );
});

test('a real file shared through links loses its region once no tool uses it', async (t) => {
  const paths = await tempPaths(t);
  const real = await linkedDotfile(paths);
  await installGlobal(paths, ['claude-code', 'codex']);
  await installGlobal(paths, ['codex']);

  const plan = await installGlobal(paths, []);

  assert.deepEqual(
    {
      content: await readFile(real, 'utf8'),
      statuses: plan.actions.map((action) => action.status),
      manifest: await manifestOf(paths),
    },
    { content: '# Mine\n', statuses: ['remove'], manifest: null },
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
    '.agents/agents-config': 'not a directory\n',
  });

  await assert.rejects(installGlobal(paths, ['copilot']), {
    name: 'ApplyError',
    message: /changed but not recorded: .*copilot-instructions\.md/,
  });
});
