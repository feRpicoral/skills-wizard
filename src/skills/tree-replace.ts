import { cp, mkdir, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import { UnsafeWriteError } from '../errors.ts';
import { lstatIfExists } from '../install/fs.ts';
import { escapingLinks, notCopied } from './tree.ts';

interface CopySkillTreeParams {
  source: string;
  destination: string;
}

export async function copySkillTree({
  source,
  destination,
}: CopySkillTreeParams): Promise<void> {
  const [escaped] = await escapingLinks(source);

  if (escaped) {
    throw new UnsafeWriteError(
      `refusing to copy ${escaped.path}: it does not resolve inside the skill (${escaped.target})`,
    );
  }

  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = relative(source, src);
      if (rel === '') return true;

      const parts = rel.split(sep);
      const name = parts.at(-1) ?? '';

      return !notCopied(name, parts.slice(0, -1));
    },
  });
}

interface SiblingPathParams {
  path: string;
  purpose: string;
}

function sibling({ path, purpose }: SiblingPathParams): string {
  return join(
    dirname(path),
    `.${basename(path)}.skills-wizard-${process.pid}.${purpose}`,
  );
}

function isCrossDevice(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EXDEV';
}

interface MoveParams {
  from: string;
  to: string;
}

async function move({ from, to }: MoveParams): Promise<void> {
  await mkdir(dirname(to), { recursive: true });

  try {
    await rename(from, to);
  } catch (error) {
    if (!isCrossDevice(error)) throw error;

    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
}

interface SwapIntoParams {
  staged: string;
  destination: string;
  backup?: string;
}

async function swapInto({
  staged,
  destination,
  backup,
}: SwapIntoParams): Promise<void> {
  const existing = await lstatIfExists(destination);

  if (existing && backup !== undefined) {
    await move({ from: destination, to: backup });
  }

  const previous =
    existing && backup === undefined
      ? sibling({ path: destination, purpose: 'old' })
      : null;

  if (previous) {
    await rm(previous, { recursive: true, force: true });
    await rename(destination, previous);
  }

  try {
    await rename(staged, destination);
  } catch (error) {
    if (previous) await rename(previous, destination);
    else if (existing && backup !== undefined) {
      await move({ from: backup, to: destination });
    }

    throw error;
  }

  if (previous) await rm(previous, { recursive: true, force: true });
}

interface ReplaceWithCopyParams {
  source: string;
  destination: string;
  backup?: string;
}

export async function replaceWithCopy({
  source,
  destination,
  backup,
}: ReplaceWithCopyParams): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const staged = sibling({ path: destination, purpose: 'new' });
  await rm(staged, { recursive: true, force: true });

  try {
    await copySkillTree({ source, destination: staged });
    await swapInto({
      staged,
      destination,
      backup,
    });
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

interface ReplaceWithLinkParams {
  target: string;
  destination: string;
  backup?: string;
}

export async function replaceWithLink({
  target,
  destination,
  backup,
}: ReplaceWithLinkParams): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const staged = sibling({ path: destination, purpose: 'new' });
  await rm(staged, { recursive: true, force: true });
  await symlink(target, staged);

  try {
    await swapInto({
      staged,
      destination,
      backup,
    });
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
