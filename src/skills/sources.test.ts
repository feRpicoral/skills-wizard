import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { SourceError } from '../errors.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { createUpstream, isolatedGitEnv } from '../test-support/git.ts';
import {
  checkSource,
  ensureSource,
  restoreSource,
  type SourceCache,
  sourceCommit,
  updateSource,
} from './sources.ts';

const REPO = 'owner/skills';
const DAY_MS = 24 * 60 * 60_000;

const FILES = {
  'README.md': '# Skills\n',
  'skills/alpha/SKILL.md': 'alpha v1\n',
  'skills/beta/SKILL.md': 'beta v1\n',
  'tools/build.sh': 'echo build\n',
};

async function cacheFor(
  t: TestContext,
  url: string,
  clock = { now: new Date('2026-01-01T00:00:00Z') },
): Promise<SourceCache> {
  const home = await tempDir(t);
  return {
    root: join(home, 'sources'),
    url: () => url,
    env: isolatedGitEnv(home),
    now: () => clock.now,
  };
}

test('ensureSource checks out only the catalog paths of a repository', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const cache = await cacheFor(t, upstream.url);

  const dir = await ensureSource(cache, {
    repo: REPO,
    paths: ['skills/alpha'],
  });

  assert.equal(dir, join(cache.root, 'owner', 'skills'));
  assert.deepEqual(await readdir(join(dir, 'skills')), ['alpha']);
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name !== '.git'),
    ['README.md', 'skills'],
  );
});

test('the path "." checks out the whole repository', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const cache = await cacheFor(t, upstream.url);

  const dir = await ensureSource(cache, { repo: REPO, paths: ['.'] });

  assert.equal(
    await readFile(join(dir, 'tools', 'build.sh'), 'utf8'),
    'echo build\n',
  );
});

test('ensureSource widens an existing checkout when the catalog adds a path', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const cache = await cacheFor(t, upstream.url);
  await ensureSource(cache, { repo: REPO, paths: ['skills/alpha'] });

  const dir = await ensureSource(cache, {
    repo: REPO,
    paths: ['skills/alpha', 'skills/beta'],
  });

  assert.deepEqual(await readdir(join(dir, 'skills')), ['alpha', 'beta']);
});

test('checkSource reuses a fresh check and queries the remote once it expires', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  const cache = await cacheFor(t, upstream.url, clock);
  const spec = { repo: REPO, paths: ['skills/alpha'] };
  await ensureSource(cache, spec);
  await checkSource(cache, spec, { force: false });
  const next = await upstream.commit({ 'skills/alpha/SKILL.md': 'alpha v2\n' });

  const cached = await checkSource(cache, spec, { force: false });
  clock.now = new Date(clock.now.getTime() + DAY_MS + 1);
  const refreshed = await checkSource(cache, spec, { force: false });

  assert.deepEqual(cached, { current: upstream.head, latest: upstream.head });
  assert.deepEqual(refreshed, { current: upstream.head, latest: next });
});

test('updateSource advances the checkout and restoreSource moves back', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const cache = await cacheFor(t, upstream.url);
  const spec = { repo: REPO, paths: ['skills/alpha'] };
  const dir = await ensureSource(cache, spec);
  const next = await upstream.commit({ 'skills/alpha/SKILL.md': 'alpha v2\n' });

  const update = await updateSource(cache, spec);
  const updated = await readFile(join(dir, 'skills/alpha/SKILL.md'), 'utf8');
  await restoreSource({ cache, repo: REPO, commit: update.previous });

  assert.deepEqual(update, { previous: upstream.head, current: next });
  assert.equal(updated, 'alpha v2\n');
  assert.equal(
    await readFile(join(dir, 'skills/alpha/SKILL.md'), 'utf8'),
    'alpha v1\n',
  );
});

test('a source pinned to a tag stays on the tag', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const tagged = await upstream.commit(
    { 'skills/alpha/SKILL.md': 'alpha v2\n' },
    'v2',
  );
  await upstream.commit({ 'skills/alpha/SKILL.md': 'alpha v3\n' });
  const cache = await cacheFor(t, upstream.url);
  const spec = { repo: REPO, ref: 'v2', paths: ['skills/alpha'] };

  const dir = await ensureSource(cache, spec);
  const check = await checkSource(cache, spec, { force: true });

  assert.equal(
    await readFile(join(dir, 'skills/alpha/SKILL.md'), 'utf8'),
    'alpha v2\n',
  );
  assert.deepEqual(check, { current: tagged, latest: tagged });
});

test('a source pinned to a commit checks out that commit', async (t) => {
  const upstream = await createUpstream(t, FILES);
  await upstream.commit({ 'skills/alpha/SKILL.md': 'alpha v2\n' });
  const cache = await cacheFor(t, upstream.url);

  await ensureSource(cache, {
    repo: REPO,
    ref: upstream.head,
    paths: ['skills/alpha'],
  });

  assert.equal(await sourceCommit(cache, REPO), upstream.head);
});

test('changing the pinned ref moves an existing checkout', async (t) => {
  const upstream = await createUpstream(t, FILES);
  await upstream.commit({ 'skills/alpha/SKILL.md': 'alpha v2\n' }, 'v2');
  const cache = await cacheFor(t, upstream.url);
  await ensureSource(cache, { repo: REPO, paths: ['skills/alpha'] });

  const dir = await ensureSource(cache, {
    repo: REPO,
    ref: upstream.head,
    paths: ['skills/alpha'],
  });

  assert.equal(
    await readFile(join(dir, 'skills/alpha/SKILL.md'), 'utf8'),
    'alpha v1\n',
  );
});

test('a repository that cannot be cloned is a SourceError and leaves nothing behind', async (t) => {
  const missing = await tempDir(t);
  const cache = await cacheFor(t, `file://${join(missing, 'nope.git')}`);

  await assert.rejects(
    ensureSource(cache, { repo: REPO, paths: ['skills/alpha'] }),
    SourceError,
  );

  assert.deepEqual(await readdir(join(cache.root, 'owner')), []);
});

test('specs git could read as options are rejected before running git', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const cache = await cacheFor(t, upstream.url);
  const specs = [
    { repo: REPO, ref: '--upload-pack=touch pwned', paths: ['skills/alpha'] },
    { repo: REPO, paths: ['--stdin'] },
    { repo: REPO, paths: ['skills/-alpha'] },
  ];

  for (const spec of specs) {
    await assert.rejects(ensureSource(cache, spec), SourceError);
    await assert.rejects(
      checkSource(cache, spec, { force: true }),
      SourceError,
    );
  }

  await assert.rejects(readdir(cache.root), { code: 'ENOENT' });
});

test('dot-segment repository names never resolve to a parent cache directory', async (t) => {
  const upstream = await createUpstream(t, FILES);
  const cache = await cacheFor(t, upstream.url);
  await writeFiles(cache.root, { 'owner/keep/file.txt': 'keep\n' });

  for (const repo of ['owner/.', 'owner/..']) {
    await assert.rejects(
      ensureSource(cache, { repo, paths: ['.'] }),
      SourceError,
    );
  }

  assert.equal(
    await readFile(join(cache.root, 'owner', 'keep', 'file.txt'), 'utf8'),
    'keep\n',
  );
});
