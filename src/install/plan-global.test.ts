import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Paths } from '../env.ts';
import { globalManifestPath, readManifest } from '../state/manifest.ts';
import { tempPaths, writeFiles } from '../test-support/fixtures.ts';
import {
  BEGIN,
  END,
  installGlobal,
  library,
  manifestOf,
  REPO,
  selection,
} from '../test-support/plan-fixtures.ts';
import { buildPlan } from './plan.ts';

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

test('deselecting tools removes only the content skills-wizard added', async (t) => {
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
    /^# Mine\n\n<!-- BEGIN:skills-wizard -->/,
  );
});

test('never replaces an unmanaged file at the command link path', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { '.local/bin/skills-wizard': 'mine\n' });

  const plan = await installGlobal(paths, ['codex'], { linkCommand: true });

  const link = plan.actions.find(
    (action) => action.label === 'skills-wizard command',
  );
  assert.equal(link?.status, 'conflict');
  assert.equal(
    await readFile(join(paths.localBin, 'skills-wizard'), 'utf8'),
    'mine\n',
  );
});

test('links the command and removes the link once deselected', async (t) => {
  const paths = await tempPaths(t);
  const link = join(paths.localBin, 'skills-wizard');
  await installGlobal(paths, ['codex'], { linkCommand: true });

  await installGlobal(paths, ['codex'], { linkCommand: false });

  await assert.rejects(lstat(link), { code: 'ENOENT' });
});

test('a still selected link that was retargeted is left alone', async (t) => {
  const paths = await tempPaths(t);
  const link = join(paths.localBin, 'skills-wizard');
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
  const link = join(paths.localBin, 'skills-wizard');
  await installGlobal(paths, ['codex'], { linkCommand: true });
  await rm(link);
  await writeFiles(paths.home, { '.local/bin/skills-wizard': 'mine\n' });

  await installGlobal(paths, ['codex'], { linkCommand: true });

  assert.equal(await readFile(link, 'utf8'), 'mine\n');
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
