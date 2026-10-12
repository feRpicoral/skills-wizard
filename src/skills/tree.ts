import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { lstatIfExists } from '../install/fs.ts';

const EXCLUDED_EVERYWHERE: ReadonlySet<string> = new Set([
  '.git',
  '.github',
  'node_modules',
  '.DS_Store',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
]);
const EXCLUDED_AT_ROOT: ReadonlySet<string> = new Set(['evals']);
const EXECUTABLE_BITS = 0o111;
const PERMISSION_BITS = 0o777;
const HASH_PREFIX = 'sha256:';

export interface TreeFile {
  path: string;
  link: boolean;
  executable: boolean;
  digest: string;
}

interface TreeEntry {
  path: string;
  absolute: string;
  link: boolean;
  mode: number;
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function walk(
  root: string,
  segments: readonly string[] = [],
): Promise<TreeEntry[]> {
  const dir = join(root, ...segments);
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const entries: TreeEntry[] = [];
  for (const child of children) {
    if (EXCLUDED_EVERYWHERE.has(child.name)) continue;
    if (segments.length === 0 && EXCLUDED_AT_ROOT.has(child.name)) continue;
    const path = [...segments, child.name];
    const absolute = join(root, ...path);
    if (child.isDirectory()) {
      entries.push(...(await walk(root, path)));
    } else if (child.isFile() || child.isSymbolicLink()) {
      const stats = await lstat(absolute);
      entries.push({
        path: path.join('/'),
        absolute,
        link: child.isSymbolicLink(),
        mode: stats.mode & PERMISSION_BITS,
      });
    }
  }
  return entries;
}

export async function snapshotTree(
  root: string,
): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  for (const entry of await walk(root)) {
    const content = entry.link
      ? await readlink(entry.absolute)
      : await readFile(entry.absolute);
    files.set(entry.path, {
      path: entry.path,
      link: entry.link,
      executable: !entry.link && (entry.mode & EXECUTABLE_BITS) !== 0,
      digest: digest(content),
    });
  }
  return files;
}

export async function hashTree(root: string): Promise<string> {
  const lines = [...(await snapshotTree(root)).values()].map(
    (file) =>
      `${file.link ? 'link' : 'file'}\0${file.path}\0${file.executable ? 'x' : '-'}\0${file.digest}\n`,
  );
  return `${HASH_PREFIX}${digest(lines.join(''))}`;
}

interface CopySkillTreeParams {
  source: string;
  destination: string;
}

export async function copySkillTree({
  source,
  destination,
}: CopySkillTreeParams): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await walk(source)) {
    const target = join(destination, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    if (entry.link) {
      await symlink(await readlink(entry.absolute), target);
    } else {
      await copyFile(entry.absolute, target);
      await chmod(target, entry.mode);
    }
  }
}

interface SiblingPathParams {
  path: string;
  purpose: string;
}

function sibling({ path, purpose }: SiblingPathParams): string {
  return join(
    dirname(path),
    `.${basename(path)}.agents-config-${process.pid}.${purpose}`,
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
  if (previous) await rename(destination, previous);
  try {
    await rename(staged, destination);
  } catch (error) {
    if (previous) await rename(previous, destination);
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
      ...(backup !== undefined ? { backup } : {}),
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
      ...(backup !== undefined ? { backup } : {}),
    });
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
