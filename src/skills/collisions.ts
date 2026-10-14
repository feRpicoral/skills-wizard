import { join } from 'node:path';

import type { Paths } from '../env.ts';
import { FrontmatterError } from '../errors.ts';
import { isRecord, parseFrontmatter } from '../frontmatter.ts';
import {
  fsErrorReason,
  lstatIfExists,
  readDirIfExists,
  readTextIfExists,
  realLocation,
} from '../install/fs.ts';
import type { Manifest } from '../state/manifest.ts';
import { TOOL_IDS, TOOLS } from '../tools/registry.ts';
import { SKILL_FILE } from './validate.ts';

export interface DiscoveredSkill {
  name: string;
  folder: string;
  path: string;
  locations: string[];
  managed: boolean;
  readOnly: boolean;
}

export interface SkillCollision {
  name: string;
  paths: string[];
}

export interface SkillScan {
  skills: DiscoveredSkill[];
  unmanaged: DiscoveredSkill[];
  collisions: SkillCollision[];
  skipped: string[];
}

export interface SkillRoot {
  dir: string;
  kind: 'canonical' | 'tool' | 'external' | 'plugin';
}

interface RawEntry {
  name: string;
  folder: string;
  path: string;
  root: SkillRoot;
  real: string;
}

async function locate(path: string): Promise<string> {
  try {
    return (await realLocation(path)) ?? path;
  } catch (error) {
    if (fsErrorReason(error) === undefined) throw error;
    return path;
  }
}

export async function skillRoots(paths: Paths): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();
  const add = async (root: SkillRoot) => {
    const real = await locate(root.dir);
    if (seen.has(real)) return;
    seen.add(real);
    roots.push(root);
  };

  await add({ dir: paths.skillsDir, kind: 'canonical' });
  for (const id of TOOL_IDS) {
    const dir = TOOLS[id].global.skills?.(paths);
    if (dir) await add({ dir, kind: 'tool' });
  }
  for (const id of TOOL_IDS) {
    for (const dir of TOOLS[id].global.extraSkills?.(paths) ?? []) {
      await add({ dir, kind: 'external' });
    }
  }
  await add({ dir: join(paths.codexHome, 'skills'), kind: 'external' });

  for (const pluginsDir of [
    join(paths.geminiHome, 'config', 'plugins'),
    join(paths.geminiHome, 'antigravity-cli', 'plugins'),
  ]) {
    let plugins;
    try {
      plugins = await readDirIfExists(pluginsDir);
    } catch (error) {
      if (fsErrorReason(error) === undefined) throw error;
      plugins = null;
    }
    for (const entry of plugins ?? []) {
      if (entry.name.startsWith('.')) continue;
      await add({
        dir: join(pluginsDir, entry.name, 'skills'),
        kind: 'plugin',
      });
    }
  }
  return roots;
}

async function readDeclaredName(
  entryPath: string,
  skipped: string[],
): Promise<string | null> {
  let content: string | null;
  try {
    content = await readTextIfExists(join(entryPath, SKILL_FILE));
  } catch (error) {
    if (fsErrorReason(error) === undefined) throw error;
    skipped.push(entryPath);
    return null;
  }
  if (content === null) {
    skipped.push(entryPath);
    return null;
  }
  try {
    const { data } = parseFrontmatter({ source: content, file: SKILL_FILE });
    if (!isRecord(data) || typeof data.name !== 'string') return null;
    const name = data.name.trim();
    return name || null;
  } catch (error) {
    if (error instanceof FrontmatterError) return null;
    throw error;
  }
}

async function scanRoot(
  root: SkillRoot,
  skipped: string[],
): Promise<RawEntry[]> {
  let children;
  try {
    children = await readDirIfExists(root.dir);
  } catch (error) {
    if (fsErrorReason(error) === undefined) throw error;
    skipped.push(root.dir);
    return [];
  }
  if (!children) return [];
  children.sort((a, b) => a.name.localeCompare(b.name));

  const entries: RawEntry[] = [];
  for (const child of children) {
    if (child.name.startsWith('.')) continue;
    const path = join(root.dir, child.name);
    let stats;
    try {
      stats = await lstatIfExists(path);
    } catch (error) {
      if (fsErrorReason(error) === undefined) throw error;
      skipped.push(path);
      continue;
    }
    if (!stats || (!stats.isDirectory() && !stats.isSymbolicLink())) continue;

    const name = await readDeclaredName(path, skipped);
    if (!name) continue;

    entries.push({
      name,
      folder: child.name,
      path,
      root,
      real: await locate(path),
    });
  }
  return entries;
}

/**
 * Scans all canonical, tool, external, and plugin skill directories under
 * `paths` to discover installed skills, unmanaged skills, and name collisions.
 *
 * Deduplicates skills that resolve to the same `realLocation` across distinct
 * roots (such as a tool skill symlink pointing into the canonical `.agents/skills`
 * folder), while treating two entries within the same root or distinct real
 * folders declaring the same `SKILL.md` frontmatter `name` as separate entries
 * so collisions are surfaced.
 */
export async function scanInstalledSkills(
  paths: Paths,
  manifest: Manifest | null,
): Promise<SkillScan> {
  const ownedPaths = new Set(
    (manifest?.entries ?? [])
      .filter((entry) => entry.kind === 'skill' || entry.kind === 'symlink')
      .map((entry) => entry.path),
  );
  const ownedSkills = new Set(manifest?.skills ?? []);
  const skipped: string[] = [];
  const rawEntries: RawEntry[] = [];

  for (const root of await skillRoots(paths)) {
    rawEntries.push(...(await scanRoot(root, skipped)));
  }

  const readOnly = new Set(
    rawEntries
      .filter(({ root }) => root.kind === 'external' || root.kind === 'plugin')
      .map((entry) => entry.real),
  );
  const byLocation = new Map<string, DiscoveredSkill>();
  const rootsOf = new Map<DiscoveredSkill, Set<SkillRoot>>();
  const skills: DiscoveredSkill[] = [];

  for (const entry of rawEntries) {
    const known = byLocation.get(entry.real);
    const knownRoots = known ? rootsOf.get(known) : undefined;
    if (known && knownRoots && !knownRoots.has(entry.root)) {
      known.locations.push(entry.path);
      knownRoots.add(entry.root);
      continue;
    }
    const skill: DiscoveredSkill = {
      name: entry.name,
      folder: entry.folder,
      path: entry.path,
      locations: [entry.path],
      managed: ownedPaths.has(entry.path) && ownedSkills.has(entry.name),
      readOnly: readOnly.has(entry.real),
    };
    if (!known) byLocation.set(entry.real, skill);
    rootsOf.set(skill, new Set([entry.root]));
    skills.push(skill);
  }

  const byName = new Map<string, string[]>();
  for (const skill of skills) {
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill.path]);
  }
  const collisions: SkillCollision[] = [...byName.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([name, locations]) => ({ name, paths: locations }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const unmanaged = skills
    .filter((skill) => !skill.readOnly && !skill.managed)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { skills, unmanaged, collisions, skipped };
}
