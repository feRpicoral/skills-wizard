import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { skillSource, tempDir, writeFiles } from '../test-support/fixtures.ts';
import { createUpstream, isolatedGitEnv } from '../test-support/git.ts';
import { resolveSkillSources } from './install.ts';
import { loadSkillLibrary } from './library.ts';
import type { SourceCache } from './sources.ts';
import { hashTree } from './tree.ts';

const CATALOG = [
  'categories:',
  '  docs: Docs',
  'skills:',
  '  - name: alpha',
  '    repo: owner/skills',
  '    path: skills/alpha',
  '    category: docs',
  '    scopes: [global, project]',
  '    setup: echo ready',
  '  - name: beta',
  '    repo: owner/skills',
  '    path: skills/beta',
  '    category: docs',
  '    scopes: [global, project]',
  '',
].join('\n');

async function fixture(t: TestContext, url: string) {
  const root = await tempDir(t);
  await writeFiles(root, {
    'catalog.yaml': CATALOG,
    'skills/notes/SKILL.md': skillSource('notes'),
  });
  const home = await tempDir(t);
  const cache: SourceCache = {
    root: join(home, 'sources'),
    url: () => url,
    env: isolatedGitEnv(home),
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
  return { library: await loadSkillLibrary(root), cache, root };
}

test('resolves catalog skills from the cache with their provenance', async (t) => {
  const upstream = await createUpstream(t, {
    'skills/alpha/SKILL.md': skillSource('alpha'),
    'skills/beta/SKILL.md': skillSource('beta'),
  });
  const { library, cache } = await fixture(t, upstream.url);

  const { sources, problems } = await resolveSkillSources({
    library,
    names: ['alpha'],
    cache,
    fetch: true,
  });

  const alphaDir = join(cache.root, 'owner', 'skills', 'skills', 'alpha');
  assert.deepEqual(problems, new Map());
  assert.deepEqual(sources.get('alpha'), {
    dir: alphaDir,
    record: {
      type: 'catalog',
      repo: 'owner/skills',
      path: 'skills/alpha',
      commit: upstream.head,
    },
    linkable: false,
    setup: 'echo ready',
    hash: await hashTree(alphaDir),
  });
});

test('resolves first-party skills from the repository without fetching', async (t) => {
  const { library, cache, root } = await fixture(t, 'file:///nowhere.git');

  const { sources } = await resolveSkillSources({
    library,
    names: ['notes'],
    cache,
    fetch: true,
  });

  const notesDir = join(root, 'skills', 'notes');
  assert.deepEqual(sources.get('notes'), {
    dir: notesDir,
    record: { type: 'local', path: 'skills/notes' },
    linkable: true,
    hash: await hashTree(notesDir),
  });
});

test('a skill whose link chain leaves the skill folder is skipped with a problem', async (t) => {
  const { library, cache, root } = await fixture(t, 'file:///nowhere.git');
  const dir = join(root, 'skills', 'notes');
  await writeFiles(dir, { 'deep/file.md': 'f\n' });
  await symlink('..', join(dir, 'deep', 'up'));
  await symlink('deep/up/../../secret.txt', join(dir, 'leak'));

  const { sources, problems } = await resolveSkillSources({
    library,
    names: ['notes'],
    cache,
    fetch: false,
  });

  assert.equal(sources.has('notes'), false);
  assert.equal(
    problems.get('notes'),
    'leak does not resolve inside the skill folder (deep/up/../../secret.txt); links must be relative and stay inside it',
  );
});

test('an upstream SKILL.md that declares another name is not installed', async (t) => {
  const upstream = await createUpstream(t, {
    'skills/alpha/SKILL.md': skillSource('alpha-renamed'),
    'skills/beta/SKILL.md': skillSource('beta'),
  });
  const { library, cache } = await fixture(t, upstream.url);

  const { sources, problems } = await resolveSkillSources({
    library,
    names: ['alpha', 'beta'],
    cache,
    fetch: true,
  });

  assert.deepEqual([...sources.keys()], ['beta']);
  assert.equal(
    problems.get('alpha'),
    'declares name "alpha-renamed" instead of "alpha"',
  );
});

test('a repository that cannot be fetched marks its skills as unavailable', async (t) => {
  const missing = await tempDir(t);
  const { library, cache } = await fixture(
    t,
    `file://${join(missing, 'gone.git')}`,
  );

  const { sources, problems } = await resolveSkillSources({
    library,
    names: ['alpha', 'beta'],
    cache,
    fetch: true,
  });

  assert.equal(sources.size, 0);
  assert.match(problems.get('beta') ?? '', /^Could not clone owner\/skills/);
});

test('without fetching, a repository that was never downloaded is reported', async (t) => {
  const { library, cache } = await fixture(t, 'file:///nowhere.git');

  const { problems } = await resolveSkillSources({
    library,
    names: ['alpha'],
    cache,
    fetch: false,
  });

  assert.equal(
    problems.get('alpha'),
    'owner/skills has not been downloaded yet',
  );
});
