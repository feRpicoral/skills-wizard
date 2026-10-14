import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { ManifestError } from '../errors.ts';
import { tempDir } from '../test-support/fixtures.ts';
import {
  checkMcpEntries,
  checkSkillEntries,
  type Manifest,
  MANIFEST_VERSION,
  projectManifestPath,
  readGlobalManifest,
  readManifest,
  readProjectManifest,
  writeManifest,
} from './manifest.ts';

function manifest(entries: Manifest['entries']): Manifest {
  return {
    version: MANIFEST_VERSION,
    scope: 'project',
    tools: ['claude-code'],
    blocks: ['core/no-ai-tells'],
    skills: [],
    mcp: [],
    variables: {},
    options: { keepLocal: false },
    entries,
  };
}

async function storeRaw(file: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...manifest([]), entries }));
}

test('project manifests store entry paths relative to the project', async (t) => {
  const project = await realpath(await tempDir(t));
  const file = projectManifestPath(project);
  const original = manifest([
    {
      kind: 'line',
      path: join(project, 'CLAUDE.md'),
      line: '@AGENTS.md',
      added: true,
      createdFile: true,
    },
  ]);

  await writeManifest({ file, manifest: original, projectDir: project });
  const stored = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  const restored = await readProjectManifest(file, { dir: project });

  assert.equal(stored.entries[0]?.path, 'CLAUDE.md');
  assert.deepEqual(restored, { manifest: original, ignored: [] });
});

test('readProjectManifest returns null when no manifest exists', async (t) => {
  const project = await realpath(await tempDir(t));

  const result = await readProjectManifest(projectManifestPath(project), {
    dir: project,
  });

  assert.equal(result, null);
});

test('readManifest rejects a manifest with an invalid shape', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify({ version: 2 }));

  await assert.rejects(readManifest(file), ManifestError);
});

test('project manifests cannot reference paths outside the project', async (t) => {
  const project = await realpath(await tempDir(t));
  const file = projectManifestPath(project);
  await storeRaw(file, [
    {
      kind: 'line',
      path: '../../.bashrc',
      line: 'set -o noclobber',
      added: true,
      createdFile: false,
    },
  ]);

  await assert.rejects(
    readProjectManifest(file, { dir: project }),
    /outside the project/,
  );
});

test('project manifests cannot use absolute paths', async (t) => {
  const project = await realpath(await tempDir(t));
  const file = projectManifestPath(project);
  await storeRaw(file, [
    { kind: 'region', path: '/etc/hosts', createdFile: false },
  ]);

  await assert.rejects(
    readProjectManifest(file, { dir: project }),
    /must be relative/,
  );
});

test('a git exclude entry from another repository is ignored, not trusted', async (t) => {
  const project = await realpath(await tempDir(t));
  const file = projectManifestPath(project);
  await storeRaw(file, [
    {
      kind: 'exclude-region',
      path: '../other/.git/info/exclude',
      id: '.',
      createdFile: false,
    },
    { kind: 'region', path: 'AGENTS.md', createdFile: true },
  ]);

  const result = await readProjectManifest(file, {
    dir: project,
    gitExcludePath: join(project, '.git', 'info', 'exclude'),
  });

  assert.deepEqual(result?.ignored, ['../other/.git/info/exclude']);
  assert.deepEqual(
    result?.manifest.entries.map((entry) => entry.kind),
    ['region'],
  );
});

test('a project manifest that links outside the project is refused before reading', async (t) => {
  const project = await realpath(await tempDir(t));
  const outside = await realpath(await tempDir(t));
  await writeFile(join(outside, 'manifest.json'), '{}');
  await mkdir(join(project, '.agents'));
  await symlink(join(outside, 'manifest.json'), projectManifestPath(project));

  await assert.rejects(
    readProjectManifest(projectManifestPath(project), { dir: project }),
    /resolves outside the project/,
  );
});

test('a manifest path that is not a regular file is refused', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  await mkdir(file);

  await assert.rejects(readManifest(file), /is not a regular file/);
});

test('a recorded skill name must follow the skill naming rules', async (t) => {
  const project = await realpath(await tempDir(t));
  const file = projectManifestPath(project);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ ...manifest([]), skills: ['../../outside'] }),
  );

  await assert.rejects(
    readProjectManifest(file, { dir: project }),
    /must be a valid skill name/,
  );
});

const projectFolders = {
  copies: '/work/app/.agents/skills',
  links: ['/work/app/.claude/skills'],
};

const copyInstall = { mode: 'copy', hash: 'sha256:0' } as const;

test('a skill entry must sit in the skills folder under its own name', () => {
  assert.throws(
    () =>
      checkSkillEntries({
        file: 'manifest.json',
        entries: [
          {
            kind: 'skill',
            path: '/work/app/src/lib',
            name: 'lib',
            source: { type: 'local', path: 'skills/lib' },
            install: copyInstall,
          },
        ],
        folders: projectFolders,
        scope: 'project',
      }),
    /the lib skill must be recorded at \/work\/app\/\.agents\/skills\/lib/,
  );
});

test('a skill entry named after another folder is refused', () => {
  assert.throws(
    () =>
      checkSkillEntries({
        file: 'manifest.json',
        entries: [
          {
            kind: 'skill',
            path: '/work/app/.agents/skills/other',
            name: 'notes',
            source: { type: 'local', path: 'skills/notes' },
            install: copyInstall,
          },
        ],
        folders: projectFolders,
        scope: 'project',
      }),
    ManifestError,
  );
});

test('a project symlink entry outside the tool skills folders is refused', () => {
  assert.throws(
    () =>
      checkSkillEntries({
        file: 'manifest.json',
        entries: [
          { kind: 'symlink', path: '/work/app/src/lib', target: 'elsewhere' },
        ],
        folders: projectFolders,
        scope: 'project',
      }),
    /is not a skill link in a tool skills folder/,
  );
});

test('a symlink entry in a tool skills folder must be named after a skill', () => {
  assert.throws(
    () =>
      checkSkillEntries({
        file: 'manifest.json',
        entries: [
          {
            kind: 'symlink',
            path: '/home/me/.claude/skills/Not_A_Skill',
            target: '/home/me/.agents/skills/notes',
          },
        ],
        folders: {
          copies: '/home/me/.agents/skills',
          links: ['/home/me/.claude/skills'],
        },
        scope: 'global',
      }),
    /is not a skill link in a tool skills folder/,
  );
});

test('global skill entries and the command link pass the check', () => {
  assert.doesNotThrow(() =>
    checkSkillEntries({
      file: 'manifest.json',
      entries: [
        {
          kind: 'skill',
          path: '/home/me/.agents/skills/notes',
          name: 'notes',
          source: { type: 'local', path: 'skills/notes' },
          install: copyInstall,
        },
        {
          kind: 'symlink',
          path: '/home/me/.claude/skills/notes',
          target: '/home/me/.agents/skills/notes',
        },
        {
          kind: 'symlink',
          path: '/home/me/.local/bin/skills-wizard',
          target: '/repo/src/cli.ts',
        },
      ],
      folders: {
        copies: '/home/me/.agents/skills',
        links: ['/home/me/.claude/skills'],
      },
      scope: 'global',
    }),
  );
});

test('system-wide manifests cannot use relative paths', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  await storeRaw(file, [
    { kind: 'region', path: '.codex/AGENTS.md', createdFile: true },
  ]);

  await assert.rejects(readGlobalManifest(file), /must be absolute/);
});

test('system-wide manifests cannot record relative symlink targets', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  await storeRaw(file, [
    {
      kind: 'symlink',
      path: join(dir, 'skills-wizard'),
      target: 'src/cli.ts',
    },
  ]);

  await assert.rejects(readGlobalManifest(file), /must be absolute/);
});

test('system-wide manifests cannot record relative skill link targets', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  await storeRaw(file, [
    {
      kind: 'skill',
      path: join(dir, '.agents/skills/notes'),
      name: 'notes',
      source: { type: 'local', path: 'skills/notes' },
      install: { mode: 'link', target: 'skills/notes' },
    },
  ]);

  await assert.rejects(readGlobalManifest(file), /must be absolute/);
});

test('project manifests cannot record link-mode skill entries', () => {
  assert.throws(
    () =>
      checkSkillEntries({
        file: 'manifest.json',
        entries: [
          {
            kind: 'skill',
            path: '/work/app/.agents/skills/notes',
            name: 'notes',
            source: { type: 'local', path: 'skills/notes' },
            install: { mode: 'link', target: '/repo/skills/notes' },
          },
        ],
        folders: projectFolders,
        scope: 'project',
      }),
    /project skills must be installed as copies, not links/,
  );
});

test('system-wide manifests with absolute paths are read', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  const entries: Manifest['entries'] = [
    { kind: 'region', path: join(dir, 'AGENTS.md'), createdFile: true },
  ];
  await storeRaw(file, entries);

  assert.deepEqual((await readGlobalManifest(file))?.entries, entries);
});

test('checkMcpEntries rejects MCP entries outside known tool config paths', () => {
  const mcpPaths = {
    json: ['/work/app/.mcp.json', '/work/app/.agents/mcp_config.json'],
    toml: ['/work/app/.codex/config.toml'],
  };

  const validCheck = () =>
    checkMcpEntries({
      file: 'manifest.json',
      entries: [
        {
          kind: 'mcp-json',
          path: '/work/app/.mcp.json',
          servers: ['context7'],
          createdFile: true,
        },
        {
          kind: 'mcp-toml',
          path: '/work/app/.codex/config.toml',
          servers: ['context7'],
          createdFile: true,
        },
      ],
      mcpPaths,
    });
  const invalidJsonCheck = () =>
    checkMcpEntries({
      file: 'manifest.json',
      entries: [
        {
          kind: 'mcp-json',
          path: '/work/app/package.json',
          servers: ['context7'],
          createdFile: true,
        },
      ],
      mcpPaths,
    });
  const invalidTomlCheck = () =>
    checkMcpEntries({
      file: 'manifest.json',
      entries: [
        {
          kind: 'mcp-toml',
          path: '/work/app/pyproject.toml',
          servers: ['context7'],
          createdFile: true,
        },
      ],
      mcpPaths,
    });

  assert.doesNotThrow(validCheck);
  assert.throws(invalidJsonCheck, /is not a tool MCP JSON config file/);
  assert.throws(invalidTomlCheck, /is not a tool MCP TOML config file/);
});
