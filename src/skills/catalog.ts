import { join, posix } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { SCOPES } from '../blocks/library.ts';
import { CatalogError } from '../errors.ts';
import { readTextIfExists } from '../install/fs.ts';
import { isSkillName } from './validate.ts';

const CATALOG_FILE = 'catalog.yaml';
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WHOLE_REPOSITORY = '.';

function isRepositoryPath(path: string): boolean {
  if (path === WHOLE_REPOSITORY) return true;
  return (
    posix.normalize(path) === path &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    !path.split('/').includes('..')
  );
}

const entrySchema = z.strictObject({
  name: z.string().refine(isSkillName, 'must follow the skill naming rules'),
  repo: z.string().regex(REPOSITORY, 'must be owner/repo'),
  path: z
    .string()
    .refine(isRepositoryPath, 'must be "." or a path inside the repository'),
  ref: z.string().min(1).optional(),
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
