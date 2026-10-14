import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

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

export function notCopied(name: string, segments: readonly string[]): boolean {
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
  children.sort((a, b) => compareNames(a.name, b.name));

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

/**
 * Computes a deterministic `sha256:<hex>` content and permission digest of the
 * copyable files and symlinks in a skill source directory `root`.
 *
 * Excludes repository metadata (`.git`, `.github`), agent instruction files
 * (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`), root `evals/`, generated files
 * (`.DS_Store`, `__pycache__`, `*.pyc`, `.pytest_cache`), and setup output
 * (`node_modules`, `.venv`).
 */
export async function hashTree(root: string): Promise<string> {
  return hashFiles(await snapshotTree(root));
}

interface HashInstalledCopyParams {
  dir: string;
  setup: boolean;
}

/**
 * Computes a `sha256:<hex>` digest of an installed skill copy at `dir` for
 * ownership comparison against the recorded source hash.
 *
 * Unlike {@link hashTree}, this includes any user-added files (such as `.git`,
 * `AGENTS.md`, or `evals/`) so local edits are detected, while ignoring OS/Python
 * cache artifacts and—when `setup` is `true`—setup output (`node_modules`, `.venv`).
 */
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

/**
 * Finds all symlinks inside the copyable skill tree at `root` that are
 * absolute, exceed the symlink hop limit, or resolve outside `root` when
 * following intermediate links component by component.
 */
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

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
