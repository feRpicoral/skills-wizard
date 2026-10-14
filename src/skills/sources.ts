import { execFile } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { Environment } from '../env.ts';
import { SourceError } from '../errors.ts';
import { isDirectory } from '../install/fs.ts';
import {
  isCommitSha,
  isGitRef,
  isRepository,
  isRepositoryPath,
  WHOLE_REPOSITORY,
} from './catalog.ts';
import {
  listRepositoryFiles,
  type ListRepositoryFilesParams,
  readRepositoryBlob,
  type ReadRepositoryBlobParams,
  type RepositoryTreeFile,
} from './git-tree.ts';
import { failureDetail } from './process.ts';
import {
  checkSource,
  readState,
  type SourceState,
  writeState,
} from './source-state.ts';

export {
  checkSource,
  listRepositoryFiles,
  type ListRepositoryFilesParams,
  readRepositoryBlob,
  type ReadRepositoryBlobParams,
  type RepositoryTreeFile,
};

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
export const DEFAULT_REF = 'HEAD';
export const END_OF_OPTIONS = '--end-of-options';

export interface SourceSettings {
  url: (repo: string) => string;
  env: Environment;
  now: () => Date;
  mcpRegistryUrl?: string | ((options?: { official?: boolean }) => string);
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

export function githubUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

export function sourceDir(cache: SourceCache, repo: string): string {
  if (!isRepository(repo)) {
    throw new SourceError(`${repo} is not an owner/repo name`);
  }
  return join(cache.root, ...repo.split('/'));
}

export function checkSpec(spec: SourceSpec): void {
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

export interface GitRunParams {
  cache: SourceCache;
  args: string[];
  failure: string;
  cwd?: string;
}

export async function gitRaw({
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

export async function git(params: GitRunParams): Promise<string> {
  return (await gitRaw(params)).trim();
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

interface ApplyPathsParams {
  cache: SourceCache;
  dir: string;
  spec: SourceSpec;
  isFreshClone?: boolean;
}

async function applyPaths({
  cache,
  dir,
  spec,
  isFreshClone = false,
}: ApplyPathsParams): Promise<void> {
  const failure = `Could not limit the checkout of ${spec.repo}`;
  const sparse = await isSparse(cache, dir);
  if (spec.paths.includes(WHOLE_REPOSITORY)) {
    if (sparse) {
      await git({
        cache,
        args: ['sparse-checkout', 'disable'],
        failure,
        cwd: dir,
      });
    }
    return;
  }
  if (!isFreshClone && !sparse) return;
  const wanted = [...new Set(spec.paths)].sort();
  if (sparse) {
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
    const merged = [...new Set([...current, ...wanted])].sort();
    if (current.join('\n') === merged.join('\n')) return;
    await git({
      cache,
      args: ['sparse-checkout', 'set', '--cone', ...merged],
      failure,
      cwd: dir,
    });
    return;
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
  const pinnedCommit = spec.ref !== undefined && isCommitSha(spec.ref);
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
    await applyPaths({ cache, dir: staging, spec, isFreshClone: true });
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

/**
 * Ensures the repository described by `spec` is cloned into `cache`, checked
 * out at `spec.ref`, and configured with cone-mode sparse checkout for
 * `spec.paths`.
 *
 * Clones into a sibling staging directory on first download before atomically
 * renaming into place; on subsequent calls, updates the sparse-checkout cone
 * and fetches/checks out `spec.ref` if the recorded ref changed.
 */
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
  await applyPaths({ cache, dir, spec });
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

export async function cachedSourceRef(
  cache: SourceCache,
  repo: string,
): Promise<string | undefined> {
  const dir = await cachedSource(cache, repo);
  if (!dir) return undefined;
  const state = await readState(dir);
  return state.ref ?? undefined;
}

export interface SourceCheckoutSnapshot {
  repo: string;
  existed: boolean;
  sparse?: boolean;
  paths?: string[];
  commit?: string;
  state?: SourceState;
}

/**
 * Captures the current sparse-checkout cone, `HEAD` commit, and state file of
 * a cached repository so speculative checkout changes can be rolled back via
 * {@link restoreSourceCheckout}.
 */
export async function snapshotSourceCheckout(
  cache: SourceCache,
  repo: string,
): Promise<SourceCheckoutSnapshot> {
  const dir = await cachedSource(cache, repo);
  if (!dir) {
    return { repo, existed: false };
  }
  const sparse = await isSparse(cache, dir);
  const paths = sparse
    ? (
        await git({
          cache,
          args: ['sparse-checkout', 'list'],
          failure: `Could not read sparse checkout paths of ${repo}`,
          cwd: dir,
        })
      )
        .split('\n')
        .filter(Boolean)
        .sort()
    : [];
  const commit = await sourceCommit(cache, repo);
  const state = await readState(dir);
  return { repo, existed: true, sparse, paths, commit, state };
}

/**
 * Restores a cached repository's sparse-checkout cone, detached `HEAD` commit,
 * and `.git/agents-config.json` state to a prior {@link SourceCheckoutSnapshot},
 * or deletes the cached checkout if `snapshot.existed` is `false`.
 */
export async function restoreSourceCheckout(
  cache: SourceCache,
  snapshot: SourceCheckoutSnapshot,
): Promise<void> {
  const dir = await cachedSource(cache, snapshot.repo);
  if (!dir) return;
  if (!snapshot.existed) {
    await rm(dir, { recursive: true, force: true });
    return;
  }
  const failure = `Could not restore checkout of ${snapshot.repo}`;
  if (snapshot.sparse === false) {
    if (await isSparse(cache, dir)) {
      await git({
        cache,
        args: ['sparse-checkout', 'disable'],
        failure,
        cwd: dir,
      });
    }
  } else if (snapshot.sparse && snapshot.paths) {
    await git({
      cache,
      args: ['sparse-checkout', 'set', '--cone', ...snapshot.paths],
      failure,
      cwd: dir,
    });
  }
  if (snapshot.commit) {
    const currentCommit = await sourceCommit(cache, snapshot.repo);
    if (currentCommit !== snapshot.commit) {
      await git({
        cache,
        args: ['checkout', '--quiet', '--detach', snapshot.commit],
        failure,
        cwd: dir,
      });
    }
  }
  if (snapshot.state) {
    await writeState(dir, snapshot.state);
  }
}

export interface RemoteRefsInfo {
  headCommit?: string;
  defaultBranch?: string;
  refCommits: ReadonlyMap<string, string>;
}

/**
 * Queries `git ls-remote --symref` for `repo` and returns the remote `HEAD`
 * commit, default branch name, and a map of branch and tag names to commits
 * (preferring peeled `^{}` targets for annotated tags).
 */
export async function inspectRemoteRefs(
  cache: SourceCache,
  repo: string,
): Promise<RemoteRefsInfo> {
  const output = await git({
    cache,
    args: ['ls-remote', '--symref', END_OF_OPTIONS, cache.url(repo)],
    failure: `Could not list remote refs of ${repo}`,
  });
  let headCommit: string | undefined;
  let defaultBranch: string | undefined;
  const refCommits = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [first = '', rawName = ''] = line.split('\t');
    if (rawName === DEFAULT_REF && first.startsWith('ref: refs/heads/')) {
      defaultBranch = first.slice('ref: refs/heads/'.length);
      continue;
    }
    const commit = first;
    if (!isCommitSha(commit) || !rawName) continue;
    if (rawName === DEFAULT_REF) {
      headCommit = commit;
      continue;
    }
    if (rawName.startsWith('refs/heads/')) {
      refCommits.set(rawName.slice('refs/heads/'.length), commit);
    } else if (rawName.startsWith('refs/tags/')) {
      const tag = rawName.endsWith('^{}')
        ? rawName.slice('refs/tags/'.length, -3)
        : rawName.slice('refs/tags/'.length);
      if (!refCommits.has(tag) || rawName.endsWith('^{}')) {
        refCommits.set(tag, commit);
      }
    }
  }
  return {
    ...(headCommit ? { headCommit } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    refCommits,
  };
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

/**
 * Fetches and checks out the latest commit for `spec.ref` (or `HEAD`) in the
 * cached repository for `spec.repo`, returning the `previous` and `current`
 * commit SHAs.
 */
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
