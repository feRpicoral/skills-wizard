import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { ManifestError } from '../errors.ts';
import { tempDir } from '../test-support/fixtures.ts';
import {
  type Manifest,
  projectManifestPath,
  readManifest,
  writeManifest,
} from './manifest.ts';

function manifest(entries: Manifest['entries']): Manifest {
  return {
    version: 1,
    scope: 'project',
    tools: ['claude-code'],
    blocks: ['core/no-ai-tells'],
    variables: {},
    options: { keepLocal: false },
    entries,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('project manifests store entry paths relative to the project', async (t) => {
  const project = await tempDir(t);
  const file = projectManifestPath(project);
  const original = manifest([
    {
      kind: 'line',
      path: join(project, 'CLAUDE.md'),
      line: '@AGENTS.md',
      createdFile: true,
    },
  ]);

  await writeManifest(file, original, project);
  const stored = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  const restored = await readManifest(file, project);

  assert.equal(stored.entries[0]?.path, 'CLAUDE.md');
  assert.deepEqual(restored, original);
});

test('readManifest returns null when no manifest exists', async (t) => {
  const project = await tempDir(t);

  const result = await readManifest(projectManifestPath(project), project);

  assert.equal(result, null);
});

test('readManifest rejects a manifest with an invalid shape', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'manifest.json');
  await writeFile(file, JSON.stringify({ version: 2 }));

  await assert.rejects(readManifest(file), ManifestError);
});
