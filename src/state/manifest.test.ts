import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { ManifestError } from '../errors.ts';
import { tempDir } from '../test-support/fixtures.ts';
import {
  type Manifest,
  MANIFEST_VERSION,
  projectManifestPath,
  readManifest,
  writeManifest,
} from './manifest.ts';

function manifest(entries: Manifest['entries']): Manifest {
  return {
    version: MANIFEST_VERSION,
    scope: 'project',
    tools: ['claude-code'],
    blocks: ['core/no-ai-tells'],
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
  const project = await tempDir(t);
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

  await writeManifest(file, original, project);
  const stored = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  const restored = await readManifest(file, { dir: project });

  assert.equal(stored.entries[0]?.path, 'CLAUDE.md');
  assert.deepEqual(restored, original);
});

test('readManifest returns null when no manifest exists', async (t) => {
  const project = await tempDir(t);

  const result = await readManifest(projectManifestPath(project), {
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
  const project = await tempDir(t);
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
    readManifest(file, { dir: project }),
    /outside the project/,
  );
});

test('project manifests cannot use absolute paths', async (t) => {
  const project = await tempDir(t);
  const file = projectManifestPath(project);
  await storeRaw(file, [
    { kind: 'region', path: '/etc/hosts', createdFile: false },
  ]);

  await assert.rejects(
    readManifest(file, { dir: project }),
    /must be relative/,
  );
});

test('a git exclude entry must match the current repository', async (t) => {
  const project = await tempDir(t);
  const file = projectManifestPath(project);
  await storeRaw(file, [
    {
      kind: 'exclude-region',
      path: '../other/.git/info/exclude',
      id: '.',
      createdFile: false,
    },
  ]);

  await assert.rejects(
    readManifest(file, {
      dir: project,
      gitExcludePath: join(project, '.git', 'info', 'exclude'),
    }),
    /does not belong to this repository/,
  );
});
