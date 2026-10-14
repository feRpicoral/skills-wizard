import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { CatalogError } from '../errors.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  appendCatalogEntries,
  type CatalogEntry,
  extendCatalog,
  loadCatalog,
} from './catalog.ts';

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

const DEPLOY: CatalogEntry = {
  name: 'deploy',
  repo: 'owner/tools',
  path: 'skills/deploy',
  category: 'workflow',
  scopes: ['global', 'project'],
  defaults: [],
};

test('extendCatalog adds missing categories and validates the merged catalog', async (t) => {
  const catalog = await load(t, [entry('mermaid', ['ref: v1'])]);

  const extended = extendCatalog({
    catalog,
    entries: [DEPLOY],
    file: 'catalog.yaml',
  });

  assert.equal(extended.categories.workflow, 'workflow');
  assert.deepEqual(extended.skills.at(-1), DEPLOY);
  assert.throws(
    () =>
      extendCatalog({
        catalog,
        entries: [{ ...DEPLOY, repo: 'owner/repo' }],
        file: 'catalog.yaml',
      }),
    /every skill from owner\/repo must use the same ref/,
  );
  assert.throws(
    () =>
      extendCatalog({
        catalog,
        entries: [{ ...DEPLOY, name: 'Not A Name' }],
        file: 'catalog.yaml',
      }),
    CatalogError,
  );
  assert.throws(
    () =>
      extendCatalog({
        catalog,
        entries: [{ ...DEPLOY, path: './skills/deploy' }],
        file: 'catalog.yaml',
      }),
    CatalogError,
  );
});

test('appendCatalogEntries appends after the unchanged catalog text', async (t) => {
  const dir = await tempDir(t);
  const original = await readFile(REPO_CATALOG, 'utf8');
  await writeFiles(dir, { 'catalog.yaml': original });
  const file = join(dir, 'catalog.yaml');

  await appendCatalogEntries(file, [DEPLOY]);

  assert.equal(
    await readFile(file, 'utf8'),
    [
      original,
      '  - name: deploy',
      '    repo: owner/tools',
      '    path: skills/deploy',
      '    category: workflow',
      '    scopes: [global, project]',
      '',
    ].join('\n'),
  );
});

test('appendCatalogEntries adds new categories without reformatting the catalog', async (t) => {
  const dir = await tempDir(t);
  const original = await readFile(REPO_CATALOG, 'utf8');
  await writeFiles(dir, { 'catalog.yaml': original });
  const file = join(dir, 'catalog.yaml');

  await appendCatalogEntries(file, [
    { ...DEPLOY, category: 'new-group', defaults: ['global'] },
    { ...DEPLOY, name: 'release', path: 'skills/release' },
  ]);

  const updated = await readFile(file, 'utf8');
  const [categoriesBlock = '', skillsBlock = ''] = original.split('\nskills:');
  assert.ok(updated.startsWith(`${categoriesBlock.trimEnd()}\n`));
  assert.ok(
    updated.endsWith(
      [
        '',
        '  - name: deploy',
        '    repo: owner/tools',
        '    path: skills/deploy',
        '    category: new-group',
        '    scopes: [global, project]',
        '    defaults: [global]',
        '  - name: release',
        '    repo: owner/tools',
        '    path: skills/release',
        '    category: workflow',
        '    scopes: [global, project]',
        '',
      ].join('\n'),
    ),
  );
  assert.ok(updated.includes(`\nskills:${skillsBlock}`));
  assert.match(updated, /\n {2}new-group: new-group\n/);
  const catalog = await loadCatalog(file);
  assert.deepEqual(
    catalog.skills.slice(-2).map((skill) => skill.name),
    ['deploy', 'release'],
  );
});

test('appendCatalogEntries leaves the catalog untouched when an entry is invalid', async (t) => {
  const dir = await tempDir(t);
  const original = await readFile(REPO_CATALOG, 'utf8');
  await writeFiles(dir, { 'catalog.yaml': original });
  const file = join(dir, 'catalog.yaml');

  await assert.rejects(
    appendCatalogEntries(file, [{ ...DEPLOY, name: 'pretty-mermaid' }]),
    /pretty-mermaid is listed twice/,
  );

  assert.equal(await readFile(file, 'utf8'), original);
});

test('appendCatalogEntries reports invalid YAML as a catalog error', async (t) => {
  const dir = await tempDir(t);
  await writeFiles(dir, { 'catalog.yaml': 'skills: [\n' });

  await assert.rejects(
    appendCatalogEntries(join(dir, 'catalog.yaml'), [DEPLOY]),
    CatalogError,
  );
});

test('appendCatalogEntries creates a missing catalog', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'catalog.yaml');

  await appendCatalogEntries(file, [DEPLOY]);

  assert.deepEqual(await loadCatalog(file), {
    categories: { workflow: 'workflow' },
    skills: [DEPLOY],
  });
});
