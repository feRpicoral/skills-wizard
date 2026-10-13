import { join, posix } from 'node:path';

import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { SCOPES } from '../blocks/library.ts';
import { CatalogError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';
import { isSkillName } from './validate.ts';

const CATALOG_FILE = 'catalog.yaml';
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REF_FORBIDDEN = new Set(['~', '^', ':', '?', '*', '[', '\\']);
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

export function isGitRef(ref: string): boolean {
  if (COMMIT.test(ref)) return true;
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

export async function loadCatalog(file: string): Promise<Catalog> {
  const source = await readTextIfExists(file);
  if (source === null) return { categories: {}, skills: [] };

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new CatalogError(`${file} is not valid YAML`, { cause: error });
  }
  const result = catalogSchema.safeParse(raw);
  if (!result.success) {
    throw new CatalogError(`${file}: ${z.prettifyError(result.error)}`);
  }
  checkEntries(result.data, file);
  return result.data;
}

export function repositoryPaths(catalog: Catalog, repo: string): string[] {
  const paths = catalog.skills
    .filter((entry) => entry.repo === repo)
    .map((entry) => entry.path);
  return [...new Set(paths)].sort();
}

export async function appendCatalogEntries(
  file: string,
  entries: readonly CatalogEntry[],
): Promise<Catalog> {
  const current = await loadCatalog(file);
  const categories = { ...current.categories };
  for (const entry of entries) {
    if (!Object.hasOwn(categories, entry.category)) {
      categories[entry.category] = entry.category;
    }
  }
  const next: Catalog = {
    categories,
    skills: [
      ...current.skills,
      ...entries.map((entry) => entrySchema.parse(entry)),
    ],
  };
  checkEntries(next, file);
  const serialized = {
    categories: next.categories,
    skills: next.skills.map(({ defaults, ...rest }) =>
      defaults.length > 0 ? { ...rest, defaults } : rest,
    ),
  };
  await writeTextAtomic({ path: file, content: stringify(serialized) });
  return next;
}
