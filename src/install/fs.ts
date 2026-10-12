import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

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

export function isInside(dir: string, path: string): boolean {
  return path.startsWith(`${dir}${sep}`);
}

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

export async function writeTextAtomic(
  path: string,
  content: string,
): Promise<void> {
  const existing = await lstatIfExists(path);
  if (existing?.isSymbolicLink()) {
    throw new UnsafeWriteError(`refusing to replace the symlink at ${path}`);
  }

  await mkdir(dirname(path), { recursive: true });
  const mode = existing ? existing.mode & 0o777 : undefined;
  await writeFileAtomic(path, content, mode === undefined ? {} : { mode });
}

export async function replaceSymlink(
  target: string,
  path: string,
): Promise<void> {
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
