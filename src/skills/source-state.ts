import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { Environment } from '../env.ts';
import { SourceError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';
import {
  isCommitSha,
  isGitRef,
  isRepository,
  isRepositoryPath,
} from './catalog.ts';
import { failureDetail } from './process.ts';

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const STATE_FILE = 'agents-config.json';

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

export interface UpdateCheck {
  current: string;
  latest: string;
}

export interface CheckSourceOptions {
  force: boolean;
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

const stateSchema = z.object({
  ref: z.string().nullable().default(null),
  checkedAt: z.iso.datetime().optional(),
  latest: z.string().optional(),
});

export type SourceState = z.infer<typeof stateSchema>;

function stateFile(dir: string): string {
  return join(dir, '.git', STATE_FILE);
}

export async function readState(dir: string): Promise<SourceState> {
  const content = await readTextIfExists(stateFile(dir));
  if (content === null) return { ref: null };
  try {
    const result = stateSchema.safeParse(JSON.parse(content));
    return result.success ? result.data : { ref: null };
  } catch {
    return { ref: null };
  }
}

export async function writeState(
  dir: string,
  state: SourceState,
): Promise<void> {
  await writeTextAtomic({
    path: stateFile(dir),
    content: `${JSON.stringify(state, null, 2)}\n`,
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

/**
 * Checks whether the cached repository for `spec` has a newer upstream commit.
 *
 * Returns immediately when `spec.ref` is a pinned commit SHA, or when a cached
 * check for the same ref is younger than 24 hours and `force` is `false`;
 * otherwise queries `git ls-remote` (preferring dereferenced annotated tags
 * `refs/tags/<ref>^{}`) and persists the check timestamp and commit in
 * `.git/agents-config.json`.
 */
export async function checkSource(
  cache: SourceCache,
  spec: SourceSpec,
  { force }: CheckSourceOptions,
): Promise<UpdateCheck> {
  checkSpec(spec);
  const dir = sourceDir(cache, spec.repo);
  const current = await sourceCommit(cache, spec.repo);
  if (spec.ref !== undefined && isCommitSha(spec.ref)) {
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
