import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { Environment } from '../env.ts';
import { SourceError } from '../errors.ts';
import {
  isDirectory,
  readTextIfExists,
  writeTextAtomic,
} from '../install/fs.ts';
import {
  isGitRef,
  isRepository,
  isRepositoryPath,
  WHOLE_REPOSITORY,
} from './catalog.ts';
import { failureDetail } from './process.ts';

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const STATE_FILE = 'agents-config.json';
const COMMIT = /^[0-9a-f]{40}$/;
const REGULAR_MODES: ReadonlySet<string> = new Set(['100644', '100755']);
const DEFAULT_REF = 'HEAD';
const END_OF_OPTIONS = '--end-of-options';

export interface SourceSettings {
  url: (repo: string) => string;
  env: Environment;
  now: () => Date;
  skillsShUrl?: string | (() => string);
  fetch?: typeof globalThis.fetch;
}

export interface SourceCache extends SourceSettings {
  root: string;
}

export interface SourceSpec {
  repo: string;
  ref?: string;
  paths: readonly string[];
}

interface UpdateCheck {
  current: string;
  latest: string;
}

interface CheckSourceOptions {
  force: boolean;
}

const stateSchema = z.object({
  ref: z.string().nullable().default(null),
  checkedAt: z.iso.datetime().optional(),
  latest: z.string().optional(),
});

type SourceState = z.infer<typeof stateSchema>;

export function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

function sourceDir(cache: SourceCache, repo: string): string {
  if (!isRepository(repo)) {
    throw new SourceError(`${repo} is not an owner/repo name`);
  }
  return join(cache.root, ...repo.split('/'));
}

function checkSpec(spec: SourceSpec): void {
  if (spec.ref !== undefined && !isGitRef(spec.ref)) {
    throw new SourceError(`${spec.repo}: ${spec.ref} is not a valid ref`);
  }
  const invalid = spec.paths.find((path) => !isRepositoryPath(path));
  if (invalid !== undefined) {
    throw new SourceError(
      `${spec.repo}: ${invalid} is not a path inside the repository`,
    );
  }
}

interface GitRunParams {
  cache: SourceCache;
  args: string[];
  failure: string;
  cwd?: string;
}

async function gitRaw({
  cache,
  args,
  failure,
  cwd,
}: GitRunParams): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      env: cache.env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    throw new SourceError(`${failure}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}

async function git(params: GitRunParams): Promise<string> {
  return (await gitRaw(params)).trim();
}

function stateFile(dir: string): string {
  return join(dir, '.git', STATE_FILE);
}

async function readState(dir: string): Promise<SourceState> {
  const content = await readTextIfExists(stateFile(dir));
  if (content === null) return { ref: null };
  try {
    const result = stateSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : { ref: null };
  } catch {
    return { ref: null };
  }
}

async function writeState(dir: string, state: SourceState): Promise<void> {
  await writeTextAtomic({
    path: stateFile(dir),
    content: `${JSON.stringify(state, null, 2)}\n`,
  });
}

async function isSparse(cache: SourceCache, dir: string): Promise<boolean> {
  const value = await git({
    cache,
    args: ['config', '--bool', '--default', 'false', 'core.sparseCheckout'],
    failure: 'Could not read the sparse checkout setting',
    cwd: dir,
  });
  return value === 'true';
}

async function applyPaths(
  cache: SourceCache,
  dir: string,
  spec: SourceSpec,
): Promise<void> {
  const failure = `Could not limit the checkout of ${spec.repo}`;
  if (spec.paths.includes(WHOLE_REPOSITORY)) {
    if (await isSparse(cache, dir)) {
      await git({
        cache,
        args: ['sparse-checkout', 'disable'],
        failure,
        cwd: dir,
      });
    }
    return;
  }
  const wanted = [...new Set(spec.paths)].sort();
  if (await isSparse(cache, dir)) {
    if (wanted.length === 0) return;
    const current = (
      await git({
        cache,
        args: ['sparse-checkout', 'list'],
        failure,
        cwd: dir,
      })
    )
      .split('\n')
      .filter(Boolean)
      .sort();
    if (current.join('\n') === wanted.join('\n')) return;
  }
  // checkSpec rejects paths starting with "-"; sparse-checkout only accepts
  // --end-of-options from git 2.44, so it is not passed here.
  await git({
    cache,
    args: ['sparse-checkout', 'set', '--cone', ...wanted],
    failure,
    cwd: dir,
  });
}

async function checkoutRef(
  cache: SourceCache,
  dir: string,
  spec: SourceSpec,
): Promise<void> {
  const failure = `Could not fetch ${spec.repo}`;
  await git({
    cache,
    args: [
      'fetch',
      '--quiet',
      '--depth',
      '1',
      END_OF_OPTIONS,
      'origin',
      spec.ref ?? DEFAULT_REF,
    ],
    failure,
    cwd: dir,
  });
  await git({
    cache,
    args: ['checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    failure,
    cwd: dir,
  });
}

async function clone(
  cache: SourceCache,
  dir: string,
  spec: SourceSpec,
): Promise<void> {
  const staging = `${dir}.agents-config-${process.pid}.tmp`;
  const pinnedCommit = spec.ref !== undefined && COMMIT.test(spec.ref);
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(dir), { recursive: true });
  try {
    await git({
      cache,
      args: [
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--filter=blob:none',
        '--no-checkout',
        ...(spec.ref && !pinnedCommit ? [`--branch=${spec.ref}`] : []),
        END_OF_OPTIONS,
        cache.url(spec.repo),
        staging,
      ],
      failure: `Could not clone ${spec.repo}`,
    });
    await applyPaths(cache, staging, spec);
    if (pinnedCommit) {
      await checkoutRef(cache, staging, spec);
    } else {
      await git({
        cache,
        args: ['checkout', '--quiet'],
        failure: `Could not check out ${spec.repo}`,
        cwd: staging,
      });
    }
    await writeState(staging, { ref: spec.ref ?? null });
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function ensureSource(
  cache: SourceCache,
  spec: SourceSpec,
): Promise<string> {
  checkSpec(spec);
  const dir = sourceDir(cache, spec.repo);
  if (!(await isDirectory(join(dir, '.git')))) {
    await clone(cache, dir, spec);
    return dir;
  }
  await applyPaths(cache, dir, spec);
  const state = await readState(dir);
  if (state.ref !== (spec.ref ?? null)) {
    await checkoutRef(cache, dir, spec);
    await writeState(dir, { ref: spec.ref ?? null });
  }
  return dir;
}

export async function cachedSource(
  cache: SourceCache,
  repo: string,
): Promise<string | null> {
  const dir = sourceDir(cache, repo);
  return (await isDirectory(join(dir, '.git'))) ? dir : null;
}

export async function sourceCommit(
  cache: SourceCache,
  repo: string,
): Promise<string> {
  return git({
    cache,
    args: ['rev-parse', 'HEAD'],
    failure: `Could not read the cached commit of ${repo}`,
    cwd: sourceDir(cache, repo),
  });
}

async function remoteCommit(
  cache: SourceCache,
  spec: SourceSpec,
): Promise<string> {
  const ref = spec.ref ?? DEFAULT_REF;
  const output = await git({
    cache,
    args: ['ls-remote', END_OF_OPTIONS, cache.url(spec.repo), ref, `${ref}^{}`],
    failure: `Could not check ${spec.repo} for updates`,
  });
  const commits = new Map(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit = '', name = ''] = line.split('\t');
        return [name, commit] as const;
      }),
  );
  const candidates =
    ref === DEFAULT_REF
      ? [DEFAULT_REF]
      : [`refs/tags/${ref}^{}`, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const commit = commits.get(candidate);
    if (commit) return commit;
  }
  throw new SourceError(`${spec.repo} has no ref named ${ref}`);
}

export async function checkSource(
  cache: SourceCache,
  spec: SourceSpec,
  { force }: CheckSourceOptions,
): Promise<UpdateCheck> {
  checkSpec(spec);
  const dir = sourceDir(cache, spec.repo);
  const current = await sourceCommit(cache, spec.repo);
  if (spec.ref !== undefined && COMMIT.test(spec.ref)) {
    return { current, latest: spec.ref };
  }

  const state = await readState(dir);
  const now = cache.now();
  const checkedAt = state.checkedAt ? Date.parse(state.checkedAt) : NaN;
  if (
    !force &&
    state.latest !== undefined &&
    state.ref === (spec.ref ?? null) &&
    now.getTime() - checkedAt < CHECK_INTERVAL_MS
  ) {
    return { current, latest: state.latest };
  }
  const latest = await remoteCommit(cache, spec);
  await writeState(dir, { ...state, checkedAt: now.toISOString(), latest });
  return { current, latest };
}

export async function updateSource(
  cache: SourceCache,
  spec: SourceSpec,
): Promise<{ previous: string; current: string }> {
  checkSpec(spec);
  const dir = sourceDir(cache, spec.repo);
  const previous = await sourceCommit(cache, spec.repo);
  await checkoutRef(cache, dir, spec);
  return { previous, current: await sourceCommit(cache, spec.repo) };
}

interface RestoreSourceParams {
  cache: SourceCache;
  repo: string;
  commit: string;
}

export async function restoreSource({
  cache,
  repo,
  commit,
}: RestoreSourceParams): Promise<void> {
  await git({
    cache,
    args: ['checkout', '--quiet', '--detach', commit],
    failure: `Could not restore ${repo}`,
    cwd: sourceDir(cache, repo),
  });
}

export interface RepositoryTreeFile {
  path: string;
  blobSha: string;
}

export interface ListRepositoryFilesParams {
  cache: SourceCache;
  repo: string;
}

export async function listRepositoryFiles({
  cache,
  repo,
}: ListRepositoryFilesParams): Promise<RepositoryTreeFile[]> {
  const output = await gitRaw({
    cache,
    args: ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
    failure: `Could not list files in ${repo}`,
    cwd: sourceDir(cache, repo),
  });
  const files: RepositoryTreeFile[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) continue;
    const meta = record.slice(0, tabIndex);
    const path = record.slice(tabIndex + 1);
    const [mode = '', type = '', blobSha = ''] = meta.split(' ');
    if (
      type === 'blob' &&
      REGULAR_MODES.has(mode) &&
      COMMIT.test(blobSha) &&
      path.length > 0
    ) {
      files.push({ path, blobSha });
    }
  }
  return files;
}

export interface ReadRepositoryBlobParams {
  cache: SourceCache;
  repo: string;
  blobSha: string;
}

export async function readRepositoryBlob({
  cache,
  repo,
  blobSha,
}: ReadRepositoryBlobParams): Promise<string> {
  if (!COMMIT.test(blobSha)) {
    throw new SourceError(`${repo}: invalid blob object id "${blobSha}"`);
  }
  return gitRaw({
    cache,
    args: ['cat-file', 'blob', blobSha],
    failure: `Could not read blob ${blobSha} in ${repo}`,
    cwd: sourceDir(cache, repo),
  });
}
