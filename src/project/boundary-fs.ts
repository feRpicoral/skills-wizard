import { join } from 'node:path';

import { isSystemError } from '../errors.ts';
import {
  isInside,
  readTextIfExists,
  realLocation,
  statIfExists,
} from '../install/fs.ts';

export interface BoundaryPathParams {
  projectDir: string;
  relativePath: string;
  root?: string;
}

export async function safeRealLocation(path: string): Promise<string | null> {
  try {
    return await realLocation(path);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

export async function resolveProjectFile({
  projectDir,
  relativePath,
  root: givenRoot,
}: BoundaryPathParams): Promise<string | null> {
  const root = givenRoot ?? (await safeRealLocation(projectDir)) ?? projectDir;
  const location = await safeRealLocation(join(root, relativePath));
  if (location === null || !isInside({ dir: root, path: location })) {
    return null;
  }
  try {
    if (!(await statIfExists(location))?.isFile()) return null;
    return location;
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

/**
 * Reads a project-relative file as UTF-8 text if it exists, is a regular file,
 * and resolves inside `projectDir` after following symlinks.
 *
 * Returns `null` when the file is missing, is not a regular file, escapes
 * `projectDir` via symlink or `..`, or fails with an OS-level `ErrnoException`.
 */
export async function readProjectFile(
  params: BoundaryPathParams,
): Promise<string | null> {
  const location = await resolveProjectFile(params);
  if (location === null) return null;
  try {
    return await readTextIfExists(location);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

export async function hasProjectFile(
  params: BoundaryPathParams,
): Promise<boolean> {
  return (await resolveProjectFile(params)) !== null;
}

export interface HasAnyRelativeFileParams {
  projectDir: string;
  candidates: readonly string[];
  root?: string;
}

export async function hasAnyRelativeFile({
  projectDir,
  candidates,
  root: givenRoot,
}: HasAnyRelativeFileParams): Promise<boolean> {
  if (candidates.length === 0) return false;
  const root = givenRoot ?? (await safeRealLocation(projectDir)) ?? projectDir;
  for (const relativePath of candidates) {
    if (await hasProjectFile({ projectDir, relativePath, root })) {
      return true;
    }
  }
  return false;
}
