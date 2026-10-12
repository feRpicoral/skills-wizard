import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { RegistryError } from '../errors.ts';
import { tempPaths, writeFiles } from '../test-support/fixtures.ts';
import { forgetProject, readProjects, recordProject } from './projects.ts';

test('recordProject lists each project once', async (t) => {
  const paths = await tempPaths(t);
  await recordProject(paths, '/work/web');
  await recordProject(paths, '/work/api');

  await recordProject(paths, '/work/web');

  assert.deepEqual(await readProjects(paths), ['/work/api', '/work/web']);
});

test('forgetting the last project removes the registry file', async (t) => {
  const paths = await tempPaths(t);
  await recordProject(paths, '/work/web');

  await forgetProject(paths, '/work/web');

  assert.deepEqual(await readProjects(paths), []);
  await assert.rejects(lstat(join(paths.stateDir, 'projects.json')), {
    code: 'ENOENT',
  });
});

test('a registry with relative paths is rejected', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.stateDir, {
    'projects.json': JSON.stringify({ version: 1, projects: ['web'] }),
  });

  await assert.rejects(readProjects(paths), RegistryError);
});
