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
  type Manifest,
  MANIFEST_VERSION,
  projectManifestPath,
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
