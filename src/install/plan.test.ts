import assert from 'node:assert/strict';
import { lstat, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { BlockLibrary } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import {
  globalManifestPath,
  type Manifest,
  projectManifestPath,
  readManifest,
} from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import type { ToolId } from '../tools/registry.ts';
import { applyPlan } from './apply.ts';
import { buildPlan, type Plan } from './plan.ts';

const BEGIN = '<!-- BEGIN:agents-config -->';
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
      body: '## Style\n\nBe direct.',
    },
  ],
};

async function globalPlan(
  paths: Paths,
  tools: ToolId[],
  options: { linkCommand?: boolean } = {},
): Promise<Plan> {
  const manifestPath = globalManifestPath(paths);
  return buildPlan({
    scope: 'global',
    selection: {
      tools,
      blocks: ['core/identity', 'core/style'],
      variables: { githubUsername: 'octocat' },
      linkCommand: options.linkCommand ?? false,
      keepLocal: false,
    },
    library,
    paths,
    repoRoot: REPO,
    previous: await readManifest(manifestPath),
    manifestPath,
    now: new Date('2026-01-01T00:00:00Z'),
  });
}

async function installGlobal(
  paths: Paths,
  tools: ToolId[],
  options: { linkCommand?: boolean } = {},
): Promise<Plan> {
  const plan = await globalPlan(paths, tools, options);
  await applyPlan(plan, globalManifestPath(paths));
  return plan;
}

async function manifestOf(paths: Paths): Promise<Manifest | null> {
  return readManifest(globalManifestPath(paths));
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
    `${BEGIN}\n# Rules\n\nGitHub username: octocat\n\n## Style\n\nBe direct.\n<!-- END:agents-config -->\n`,
  );
  assert.equal((await manifestOf(paths))?.entries.length, 3);
});

test('a second run reports every action as unchanged', async (t) => {
  const paths = await tempPaths(t);
  await installGlobal(paths, ['claude-code', 'gemini-cli']);

  const plan = await globalPlan(paths, ['claude-code', 'gemini-cli']);

  assert.ok(plan.actions.every((action) => action.status === 'unchanged'));
});

test('deselecting a tool removes only the content agents-config added', async (t) => {
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
  assert.deepEqual(
    (await manifestOf(paths))?.entries.map((entry) => entry.path),
    [join(paths.codexHome, 'AGENTS.md')],
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
  await assert.rejects(lstat(join(paths.geminiHome, 'settings.json')), {
    code: 'ENOENT',
  });
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
  await installGlobal(paths, ['codex'], { linkCommand: true });
  const link = join(paths.localBin, 'agents-config');
  const target = await readlink(link);

  await installGlobal(paths, ['codex'], { linkCommand: false });

  assert.equal(target, join(REPO, 'src', 'cli.ts'));
  await assert.rejects(lstat(link), { code: 'ENOENT' });
});

test('leaves a symlink alone when it was retargeted outside agents-config', async (t) => {
  const paths = await tempPaths(t);
  await installGlobal(paths, ['codex'], { linkCommand: true });
  const link = join(paths.localBin, 'agents-config');
  await writeFiles(paths.home, { 'other-cli': '' });
  await rm(link);
  await symlink(join(paths.home, 'other-cli'), link);

  await installGlobal(paths, ['codex'], { linkCommand: false });

  assert.equal(await readlink(link), join(paths.home, 'other-cli'));
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
  assert.deepEqual((await manifestOf(paths))?.entries, []);
});

test('project installs append after existing regions and prepend the import line', async (t) => {
  const paths = await tempPaths(t);
  const project = await tempDir(t);
  await writeFiles(project, {
    'AGENTS.md':
      '<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n',
    'CLAUDE.md': '# Claude only\n',
  });
  const manifestPath = projectManifestPath(project);

  const plan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code', 'gemini-cli'],
      blocks: ['core/style'],
      variables: {},
      linkCommand: false,
      keepLocal: false,
    },
    library,
    paths,
    repoRoot: REPO,
    previous: null,
    projectDir: project,
    projectTitle: 'app',
    manifestPath,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  await applyPlan(plan, manifestPath, project);

  assert.equal(
    await readFile(join(project, 'AGENTS.md'), 'utf8'),
    `<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n\n${BEGIN}\n## Style\n\nBe direct.\n<!-- END:agents-config -->\n`,
  );
  assert.equal(
    await readFile(join(project, 'CLAUDE.md'), 'utf8'),
    '@AGENTS.md\n\n# Claude only\n',
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(project, '.gemini', 'settings.json'), 'utf8'),
    ),
    { context: { fileName: ['AGENTS.md', 'GEMINI.md'] } },
  );
});
