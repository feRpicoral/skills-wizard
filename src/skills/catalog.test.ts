import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { CatalogError } from '../errors.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { loadCatalog } from './catalog.ts';

const REPO_CATALOG = join(import.meta.dirname, '..', '..', 'catalog.yaml');

function catalogSource(skills: string[]): string {
  return ['categories:', '  docs: Docs', 'skills:', ...skills, ''].join('\n');
}

function entry(name: string, extra: string[] = []): string {
  return [
    `  - name: ${name}`,
    '    repo: owner/repo',
    `    path: skills/${name}`,
    '    category: docs',
    '    scopes: [global, project]',
    ...extra.map((line) => `    ${line}`),
  ].join('\n');
}

async function load(t: TestContext, skills: string[]) {
  const dir = await tempDir(t);
  await writeFiles(dir, { 'catalog.yaml': catalogSource(skills) });
  return loadCatalog(join(dir, 'catalog.yaml'));
}

test('the repository catalog is valid', async () => {
  const catalog = await loadCatalog(REPO_CATALOG);

  assert.ok(catalog.skills.some((skill) => skill.name === 'pretty-mermaid'));
});

test('loads entries with their defaults filled in', async (t) => {
  const catalog = await load(t, [entry('mermaid', ['ref: v1'])]);

  assert.deepEqual(catalog.skills, [
    {
      name: 'mermaid',
      repo: 'owner/repo',
      path: 'skills/mermaid',
      ref: 'v1',
      category: 'docs',
      scopes: ['global', 'project'],
      defaults: [],
    },
  ]);
});

test('a missing catalog is empty', async (t) => {
  const dir = await tempDir(t);

  const catalog = await loadCatalog(join(dir, 'catalog.yaml'));

  assert.deepEqual(catalog, { categories: {}, skills: [] });
});

test('rejects a skill listed twice', async (t) => {
  await assert.rejects(
    load(t, [entry('mermaid'), entry('mermaid')]),
    /mermaid is listed twice/,
  );
});

test('rejects an unknown category', async (t) => {
  await assert.rejects(
    load(t, [entry('mermaid').replace('category: docs', 'category: toString')]),
    /unknown category "toString"/,
  );
});

test('rejects paths that leave the repository', async (t) => {
  const paths = ['../skills/x', '/skills/x', 'skills/x/', './skills/x'];

  const results = await Promise.allSettled(
    paths.map((path) =>
      load(t, [
        entry('mermaid').replace('path: skills/mermaid', `path: ${path}`),
      ]),
    ),
  );

  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected', 'rejected', 'rejected'],
  );
});

test('rejects defaults outside the scopes', async (t) => {
  await assert.rejects(
    load(t, [
      entry('mermaid')
        .replace('scopes: [global, project]', 'scopes: [project]')
        .concat('\n    defaults: [global]'),
    ]),
    /defaults outside its scopes: global/,
  );
});

test('rejects skills from one repository pinned to different refs', async (t) => {
  await assert.rejects(
    load(t, [entry('one', ['ref: v1']), entry('two', ['ref: v2'])]),
    /every skill from owner\/repo must use the same ref/,
  );
});

test('rejects fields the catalog does not define', async (t) => {
  await assert.rejects(
    load(t, [entry('mermaid', ['branch: main'])]),
    CatalogError,
  );
});

test('rejects refs git could read as options or invalid ref names', async (t) => {
  const refs = [
    '--upload-pack=touch /tmp/pwned',
    '-v1',
    'v1..v2',
    'feature/',
    'v1.lock',
    'has space',
    'a:b',
    'topic^',
    '.hidden',
    '@',
  ];

  const results = await Promise.allSettled(
    refs.map((ref) => load(t, [entry('mermaid', [`ref: '${ref}'`])])),
  );

  assert.deepEqual(
    results.map((result) => result.status),
    refs.map(() => 'rejected'),
  );
});

test('accepts branch, tag and commit refs', async (t) => {
  const refs = ['main', 'release/2.0', 'v1.2.3', 'a'.repeat(40)];

  const catalogs = await Promise.all(
    refs.map((ref) => load(t, [entry('mermaid', [`ref: '${ref}'`])])),
  );

  assert.deepEqual(
    catalogs.map((catalog) => catalog.skills[0]?.ref),
    refs,
  );
});

test('rejects path segments that start with a dash', async (t) => {
  await assert.rejects(
    load(t, [
      entry('mermaid').replace('path: skills/mermaid', 'path: skills/-x'),
    ]),
    CatalogError,
  );
});

test('rejects repository names that are dot segments', async (t) => {
  const repos = ['owner/.', 'owner/..', '-owner/repo'];

  const results = await Promise.allSettled(
    repos.map((repo) =>
      load(t, [entry('mermaid').replace('repo: owner/repo', `repo: ${repo}`)]),
    ),
  );

  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected', 'rejected'],
  );
});
