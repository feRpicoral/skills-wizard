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
import { failureDetail } from './process.ts';
import { checkSource, readState, writeState } from './source-state.ts';

export { checkSource };

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_REF = 'HEAD';
export const END_OF_OPTIONS = '--end-of-options';

export interface SourceSettings {
  url: (repo: string) => string;
  env: Environment;
  now: () => Date;
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

export async function git({
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
    });
    return stdout.trim();
  } catch (error) {
    throw new SourceError(`${failure}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
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
