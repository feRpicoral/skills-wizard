import { join } from 'node:path';

import type { Scope } from '../blocks/library.ts';
import { CatalogError } from '../errors.ts';
import { lstatIfExists, readDirIfExists } from '../install/fs.ts';
import {
  type Catalog,
  type CatalogEntry,
  catalogPath,
  loadCatalog,
} from './catalog.ts';
import { SKILL_FILE } from './validate.ts';

const FIRST_PARTY_DIR = 'skills';
const FIRST_PARTY_GROUP = 'First-party';
const ALL_SCOPES: readonly Scope[] = ['global', 'project'];

export type SkillOrigin =
  { type: 'catalog'; entry: CatalogEntry } | { type: 'local'; dir: string };

export interface SkillDefinition {
  name: string;
  group: string;
  scopes: Scope[];
  defaults: Scope[];
  origin: SkillOrigin;
}

export interface SkillLibrary {
  catalog: Catalog;
  skills: SkillDefinition[];
}

function firstPartyDir(repoRoot: string): string {
  return join(repoRoot, FIRST_PARTY_DIR);
}

async function firstPartySkills(repoRoot: string): Promise<SkillDefinition[]> {
  const dir = firstPartyDir(repoRoot);
  const skills: SkillDefinition[] = [];
  for (const entry of (await readDirIfExists(dir)) ?? []) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillDir = join(dir, entry.name);
    if (!(await lstatIfExists(join(skillDir, SKILL_FILE)))) continue;
    skills.push({
      name: entry.name,
      group: FIRST_PARTY_GROUP,
      scopes: [...ALL_SCOPES],
      defaults: [],
      origin: { type: 'local', dir: skillDir },
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkillLibrary(
  repoRoot: string,
): Promise<SkillLibrary> {
  const catalog = await loadCatalog(catalogPath(repoRoot));
  const local = await firstPartySkills(repoRoot);
  const listed = new Set(catalog.skills.map((entry) => entry.name));
  const clash = local.find((skill) => listed.has(skill.name));
  if (clash) {
    throw new CatalogError(
      `${clash.name} is both a first-party skill and a catalog entry`,
    );
  }

  return {
    catalog,
    skills: [
      ...local,
      ...catalog.skills.map((entry): SkillDefinition => ({
        name: entry.name,
        group: catalog.categories[entry.category] ?? entry.category,
        scopes: entry.scopes,
        defaults: entry.defaults,
        origin: { type: 'catalog', entry },
      })),
    ],
  };
}

export function findSkill(
  library: SkillLibrary,
  name: string,
): SkillDefinition | undefined {
  return library.skills.find((skill) => skill.name === name);
}

export function defaultSkillNames(
  library: SkillLibrary,
  scope: Scope,
): string[] {
  return library.skills
    .filter((skill) => skill.defaults.includes(scope))
    .map((skill) => skill.name);
}

export function unknownSkillNames(
  library: SkillLibrary,
  names: readonly string[],
): string[] {
  return names.filter((name) => !findSkill(library, name));
}
