import type { Dirent, Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { UnsafeWriteError } from '../errors.ts';

const FS_ERROR_REASONS: Readonly<Record<string, string>> = {
  EISDIR: 'is a directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ELOOP: 'has a symlink loop',
};

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function fsErrorReason(error: unknown): string | undefined {
  const code = errorCode(error);
  return code === undefined ? undefined : FS_ERROR_REASONS[code];
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function lstatIfExists(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readDirIfExists(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function readSymlink(path: string): Promise<string | null> {
  const stats = await lstatIfExists(path);
  if (!stats?.isSymbolicLink()) return null;
  return readlink(path);
}

export async function resolveIfSymlink(path: string): Promise<string | null> {
  const stats = await lstatIfExists(path);
  if (!stats?.isSymbolicLink()) return null;
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

interface InsideCheckParams {
  dir: string;
  path: string;
}

export function isInside({ dir, path }: InsideCheckParams): boolean {
  const rel = relative(dir, path);
  return (
    rel !== '' &&
    !rel.startsWith(`..${sep}`) &&
    rel !== '..' &&
    !isAbsolute(rel)
  );
}

/**
 * Resolves the canonical filesystem path for `path`, even when leaf segments do
 * not exist yet, by resolving `realpath` on the nearest existing ancestor.
 * Returns `null` if `path` or any ancestor along the path is a dangling symlink.
 */
export async function realLocation(path: string): Promise<string | null> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if ((await lstatIfExists(current))?.isSymbolicLink()) return null;
      const parent = dirname(current);
      if (parent === current) return path;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

interface WriteTextParams {
  path: string;
  content: string;
}

/**
 * Atomically writes `content` to `path` via a temporary file rename while
 * preserving existing permission bits (`0o777`).
 *
 * @throws {UnsafeWriteError} If `path` is a symbolic link, preventing atomic
 * rename from replacing the link itself instead of writing through to its target.
 */
export async function writeTextAtomic({
  path,
  content,
}: WriteTextParams): Promise<void> {
  const existing = await lstatIfExists(path);
  if (existing?.isSymbolicLink()) {
    throw new UnsafeWriteError(`refusing to replace the symlink at ${path}`);
  }

  await mkdir(dirname(path), { recursive: true });
  const mode = existing ? existing.mode & 0o777 : undefined;
  await writeFileAtomic(path, content, mode === undefined ? {} : { mode });
}

interface ReplaceSymlinkParams {
  target: string;
  path: string;
}

export async function replaceSymlink({
  target,
  path,
}: ReplaceSymlinkParams): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await symlink(target, path);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function isDirectory(path: string): Promise<boolean> {
  return (await statIfExists(path))?.isDirectory() ?? false;
}

export function fileKindProblem(stats: Stats | null): string | undefined {
  if (!stats || stats.isFile()) return undefined;
  return stats.isDirectory() ? 'is a directory' : 'is not a regular file';
}

interface SymlinkMatchParams {
  link: string;
  destination: string;
}

async function linksTo({
  link,
  destination,
}: SymlinkMatchParams): Promise<boolean> {
  const target = await readSymlink(link);
  if (target === null) return false;
  const [linked, expected] = await Promise.all([
    realLocation(resolve(dirname(link), target)),
    realLocation(destination),
  ]);
  return linked !== null && linked === expected;
}

export interface SameFileParams {
  path: string;
  other: string;
}

export async function sameFile({
  path,
  other,
}: SameFileParams): Promise<boolean> {
  if (
    (await linksTo({ link: path, destination: other })) ||
    (await linksTo({ link: other, destination: path }))
  ) {
    return true;
  }
  const [real, otherReal] = await Promise.all([
    realLocation(path),
    realLocation(other),
  ]);
  return real !== null && real === otherReal;
}
