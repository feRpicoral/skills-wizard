import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
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

export async function readSymlink(path: string): Promise<string | null> {
  const stats = await lstatIfExists(path);
  if (!stats?.isSymbolicLink()) return null;
  return readlink(path);
}

export async function writeTextAtomic(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.agents-config-${process.pid}-${Date.now()}.tmp`,
  );
  await writeFile(temporary, content);
  await rename(temporary, path);
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
