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
import { basename, dirname, isAbsolute, join } from 'node:path';

import { UnsafeWriteError } from '../errors.ts';
import { lstatIfExists } from '../install/fs.ts';

const GENERATED: ReadonlySet<string> = new Set([
  '.DS_Store',
  '__pycache__',
  '.pytest_cache',
]);
const GENERATED_SUFFIX = '.pyc';
const SETUP_OUTPUT: ReadonlySet<string> = new Set(['node_modules', '.venv']);
const NOT_COPIED: ReadonlySet<string> = new Set([
  '.git',
  '.github',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
]);
const NOT_COPIED_AT_ROOT: ReadonlySet<string> = new Set(['evals']);
const EXECUTABLE_BITS = 0o111;
const PERMISSION_BITS = 0o777;
const HASH_PREFIX = 'sha256:';
const MAX_LINK_HOPS = 40;

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

type SkipEntry = (name: string, segments: readonly string[]) => boolean;

function isGenerated(name: string, setup: boolean): boolean {
  return (
    GENERATED.has(name) ||
    name.endsWith(GENERATED_SUFFIX) ||
    (setup && SETUP_OUTPUT.has(name))
  );
}

function notCopied(name: string, segments: readonly string[]): boolean {
  return (
    isGenerated(name, true) ||
    NOT_COPIED.has(name) ||
    (segments.length === 0 && NOT_COPIED_AT_ROOT.has(name))
  );
}

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function walk(
  root: string,
  skip: SkipEntry,
  segments: readonly string[] = [],
): Promise<TreeEntry[]> {
  const dir = join(root, ...segments);
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const entries: TreeEntry[] = [];
  for (const child of children) {
    if (skip(child.name, segments)) continue;
    const path = [...segments, child.name];
    const absolute = join(root, ...path);
    if (child.isDirectory()) {
      entries.push(...(await walk(root, skip, path)));
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

async function snapshotEntries(
  entries: readonly TreeEntry[],
): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  for (const entry of entries) {
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

function hashFiles(files: Map<string, TreeFile>): string {
  const lines = [...files.values()].map(
    (file) =>
      `${file.link ? 'link' : 'file'}\0${file.path}\0${file.executable ? 'x' : '-'}\0${file.digest}\n`,
  );
  return `${HASH_PREFIX}${digest(lines.join(''))}`;
}

export async function snapshotTree(
  root: string,
): Promise<Map<string, TreeFile>> {
  return snapshotEntries(await walk(root, notCopied));
}

export async function hashTree(root: string): Promise<string> {
  return hashFiles(await snapshotTree(root));
}

interface HashInstalledCopyParams {
  dir: string;
  setup: boolean;
}

export async function hashInstalledCopy({
  dir,
  setup,
}: HashInstalledCopyParams): Promise<string> {
  const entries = await walk(dir, (name) => isGenerated(name, setup));
  return hashFiles(await snapshotEntries(entries));
}

interface LinkInTreeParams {
  root: string;
  path: string;
}

// Resolves the link one component at a time, following every link it meets
// inside the tree, so a chain such as `up -> ..` plus `leak -> up/../x` is
// caught. Components that do not exist are taken as they are written.
async function linkEscapes({ root, path }: LinkInTreeParams): Promise<boolean> {
  const resolved: string[] = [];
  const pending = path.split('/');
  let hops = 0;
  for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.pop() === undefined) return true;
      continue;
    }
    resolved.push(part);
    const location = join(root, ...resolved);
    if (!(await lstatIfExists(location))?.isSymbolicLink()) continue;
    hops += 1;
    const target = await readlink(location);
    if (hops > MAX_LINK_HOPS || isAbsolute(target)) return true;
    resolved.pop();
    pending.unshift(...target.split('/'));
  }
  return false;
}

export interface EscapingLink {
  path: string;
  target: string;
}

export async function escapingLinks(root: string): Promise<EscapingLink[]> {
  const links: EscapingLink[] = [];
  for (const entry of await walk(root, notCopied)) {
    if (!entry.link) continue;
    if (await linkEscapes({ root, path: entry.path })) {
      links.push({ path: entry.path, target: await readlink(entry.absolute) });
    }
  }
  return links;
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
  for (const entry of await walk(source, notCopied)) {
    const target = join(destination, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    if (entry.link) {
      const linked = await readlink(entry.absolute);
      if (await linkEscapes({ root: source, path: entry.path })) {
        throw new UnsafeWriteError(
          `refusing to copy ${entry.path}: it does not resolve inside the skill (${linked})`,
        );
      }
      await symlink(linked, target);
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
