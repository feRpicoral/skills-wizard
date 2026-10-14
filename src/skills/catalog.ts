import { join, posix } from 'node:path';

import { Document, isMap, isSeq, parse, parseDocument } from 'yaml';
import { z } from 'zod';

import { SCOPES } from '../blocks/library.ts';
import { CatalogError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';
import { isSkillName } from './validate.ts';

const CATALOG_FILE = 'catalog.yaml';
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REF_FORBIDDEN = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const YAML_OUTPUT = { lineWidth: 0, flowCollectionPadding: false } as const;
export const WHOLE_REPOSITORY = '.';

export function isRepository(repo: string): boolean {
  return REPOSITORY.test(repo);
}

export function isRepositoryPath(path: string): boolean {
  if (path === WHOLE_REPOSITORY) return true;
  return (
    posix.normalize(path) === path &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '..' && !part.startsWith('-'))
  );
}

function isRefCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code > 0x20 && code !== 0x7f && !REF_FORBIDDEN.has(character);
}

export function isCommitSha(ref: string): boolean {
  return COMMIT.test(ref);
}

export function isGitRef(ref: string): boolean {
  if (isCommitSha(ref)) return true;
  return (
    ref !== '@' &&
    !ref.startsWith('-') &&
    !ref.endsWith('.') &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    [...ref].every(isRefCharacter) &&
    ref
      .split('/')
      .every(
        (part) =>
          part !== '' && !part.startsWith('.') && !part.endsWith('.lock'),
      )
  );
}

const entrySchema = z.strictObject({
  name: z.string().refine(isSkillName, 'must follow the skill naming rules'),
  repo: z.string().refine(isRepository, 'must be owner/repo'),
  path: z
    .string()
    .refine(isRepositoryPath, 'must be "." or a path inside the repository'),
  ref: z
    .string()
    .min(1)
    .refine(isGitRef, 'must be a branch, tag or full commit SHA')
    .optional(),
  category: z.string().min(1),
  scopes: z.array(z.enum(SCOPES)).min(1),
  defaults: z.array(z.enum(SCOPES)).default([]),
  setup: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

const catalogSchema = z.strictObject({
  categories: z.record(z.string(), z.string().min(1)),
  skills: z.array(entrySchema),
});

export type CatalogEntry = z.infer<typeof entrySchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export function catalogPath(repoRoot: string): string {
  return join(repoRoot, CATALOG_FILE);
}

function checkEntries(catalog: Catalog, file: string): void {
  const names = new Set<string>();
  const refs = new Map<string, string | undefined>();
  for (const entry of catalog.skills) {
    if (names.has(entry.name)) {
      throw new CatalogError(`${file}: ${entry.name} is listed twice`);
    }
    names.add(entry.name);
    if (!Object.hasOwn(catalog.categories, entry.category)) {
      throw new CatalogError(
        `${file}: ${entry.name} uses the unknown category "${entry.category}"`,
      );
    }
    const outside = entry.defaults.filter(
      (scope) => !entry.scopes.includes(scope),
    );
    if (outside.length > 0) {
      throw new CatalogError(
        `${file}: ${entry.name} has defaults outside its scopes: ${outside.join(', ')}`,
      );
    }
    if (refs.has(entry.repo) && refs.get(entry.repo) !== entry.ref) {
      throw new CatalogError(
        `${file}: every skill from ${entry.repo} must use the same ref`,
      );
    }
    refs.set(entry.repo, entry.ref);
  }
}

function parseCatalog(raw: unknown, file: string): Catalog {
  const result = catalogSchema.safeParse(raw);
  if (!result.success) {
    throw new CatalogError(`${file}: ${z.prettifyError(result.error)}`);
  }
  checkEntries(result.data, file);
  return result.data;
}

export async function loadCatalog(file: string): Promise<Catalog> {
  const source = await readTextIfExists(file);
  if (source === null) return { categories: {}, skills: [] };

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new CatalogError(`${file} is not valid YAML`, { cause: error });
  }
  return parseCatalog(raw, file);
}

export function repositoryPaths(catalog: Catalog, repo: string): string[] {
  const paths = catalog.skills
    .filter((entry) => entry.repo === repo)
    .map((entry) => entry.path);
  return [...new Set(paths)].sort();
}

interface ExtendCatalogParams {
  catalog: Catalog;
  entries: readonly CatalogEntry[];
  file: string;
}

export function extendCatalog({
  catalog,
  entries,
  file,
}: ExtendCatalogParams): Catalog {
  const categories = { ...catalog.categories };
  for (const entry of entries) {
    if (!Object.hasOwn(categories, entry.category)) {
      categories[entry.category] = entry.category;
    }
  }
  return parseCatalog(
    { categories, skills: [...catalog.skills, ...entries] },
    file,
  );
}

function entryNode(doc: Document, entry: CatalogEntry) {
  const { defaults, ...rest } = entry;
  const node = doc.createNode(
    defaults.length > 0 ? { ...rest, defaults } : rest,
  );
  for (const key of ['scopes', 'defaults']) {
    const list = node.get(key, true);
    if (isSeq(list)) list.flow = true;
  }
  return node;
}

function catalogDocument(source: string | null, file: string): Document {
  if (source === null || source.trim() === '') {
    return new Document({ categories: {}, skills: [] });
  }
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    throw new CatalogError(`${file} is not valid YAML`, {
      cause: doc.errors[0],
    });
  }
  return doc;
}

/**
 * Appends `entries` to the YAML catalog at `file` while preserving existing
 * comments and formatting, and writes the updated document atomically.
 *
 * Validates the combined catalog via {@link extendCatalog}, adds any missing
 * category labels, formats `scopes` and `defaults` sequences in flow style,
 * and inserts a blank line between entries from different repositories.
 */
export async function appendCatalogEntries(
  file: string,
  entries: readonly CatalogEntry[],
): Promise<Catalog> {
  const source = await readTextIfExists(file);
  const doc = catalogDocument(source, file);
  const current = parseCatalog(doc.toJS(), file);
  const next = extendCatalog({ catalog: current, entries, file });

  const categories = doc.get('categories', true);
  const skills = doc.get('skills', true);
  if (!isMap(categories) || !isSeq(skills)) {
    throw new CatalogError(
      `${file}: categories must be a map and skills a list`,
    );
  }
  for (const [key, label] of Object.entries(next.categories)) {
    if (!Object.hasOwn(current.categories, key)) categories.set(key, label);
  }
  if (skills.items.length === 0) skills.flow = false;
  let previousRepo = current.skills.at(-1)?.repo;
  for (const entry of next.skills.slice(current.skills.length)) {
    const node = entryNode(doc, entry);
    node.spaceBefore =
      previousRepo !== undefined && previousRepo !== entry.repo;
    skills.items.push(node);
    previousRepo = entry.repo;
  }

  await writeTextAtomic({ path: file, content: doc.toString(YAML_OUTPUT) });
  return next;
}
