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
import { isSkillName, SKILL_FILE } from './validate.ts';

const FIRST_PARTY_DIR = 'skills';
const FIRST_PARTY_GROUP = 'First-party';
const ALL_SCOPES: readonly Scope[] = ['global', 'project'];

export type SkillOrigin =
  | { type: 'catalog'; entry: CatalogEntry }
  | { type: 'local'; dir: string; path: string };

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
    if (!entry.isDirectory() || !isSkillName(entry.name)) continue;
    const skillDir = join(dir, entry.name);
    if (!(await lstatIfExists(join(skillDir, SKILL_FILE)))) continue;
    skills.push({
      name: entry.name,
      group: FIRST_PARTY_GROUP,
      scopes: [...ALL_SCOPES],
      defaults: [],
      origin: {
        type: 'local',
        dir: skillDir,
        path: `${FIRST_PARTY_DIR}/${entry.name}`,
      },
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function catalogSkillDefinition(
  catalog: Catalog,
  entry: CatalogEntry,
): SkillDefinition {
  return {
    name: entry.name,
    group: catalog.categories[entry.category] ?? entry.category,
    scopes: entry.scopes,
    defaults: entry.defaults,
    origin: { type: 'catalog', entry },
  };
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
      ...catalog.skills.map((entry) => catalogSkillDefinition(catalog, entry)),
    ],
  };
}

export function extendSkillLibrary(
  library: SkillLibrary,
  catalog: Catalog,
): SkillLibrary {
  const newEntries = catalog.skills.slice(library.catalog.skills.length);
  return {
    catalog,
    skills: [
      ...library.skills,
      ...newEntries.map((entry) => catalogSkillDefinition(catalog, entry)),
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
