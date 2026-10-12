import { dirname, join, resolve } from 'node:path';

import type { Paths } from '../env.ts';
import { FrontmatterError } from '../errors.ts';
import { parseFrontmatter } from '../frontmatter.ts';
import {
  fsErrorReason,
  lstatIfExists,
  readDirIfExists,
  readSymlink,
  readTextIfExists,
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
  plugin: boolean;
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

interface SkillRoot {
  dir: string;
  kind: 'canonical' | 'tool' | 'plugin';
}

interface RawEntry {
  name: string;
  folder: string;
  path: string;
  rootKind: SkillRoot['kind'];
  linkTarget: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function skillRoots(paths: Paths): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [{ dir: paths.skillsDir, kind: 'canonical' }];
  const seen = new Set<string>([paths.skillsDir]);

  for (const id of TOOL_IDS) {
    const dir = TOOLS[id].global.skills?.(paths);
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      roots.push({ dir, kind: 'tool' });
    }
  }

  const pluginsDir = join(paths.geminiHome, 'config', 'plugins');
  let plugins;
  try {
    plugins = await readDirIfExists(pluginsDir);
  } catch (error) {
    if (fsErrorReason(error) === undefined) throw error;
    plugins = null;
  }
  for (const entry of plugins ?? []) {
    if (entry.name.startsWith('.')) continue;
    const dir = join(pluginsDir, entry.name, 'skills');
    if (!seen.has(dir)) {
      seen.add(dir);
      roots.push({ dir, kind: 'plugin' });
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

    const rawLink = stats.isSymbolicLink() ? await readSymlink(path) : null;
    const linkTarget = rawLink ? resolve(dirname(path), rawLink) : null;
    const name = await readDeclaredName(path, skipped);
    if (!name) continue;

    entries.push({
      name,
      folder: child.name,
      path,
      rootKind: root.kind,
      linkTarget,
    });
  }
  return entries;
}

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

  const canonicalByPath = new Map<string, DiscoveredSkill>();
  const skills: DiscoveredSkill[] = [];

  for (const entry of rawEntries) {
    if (entry.rootKind !== 'canonical') continue;
    const skill: DiscoveredSkill = {
      name: entry.name,
      folder: entry.folder,
      path: entry.path,
      locations: [entry.path],
      managed: ownedPaths.has(entry.path) && ownedSkills.has(entry.name),
      plugin: false,
    };
    canonicalByPath.set(entry.path, skill);
    skills.push(skill);
  }

  for (const entry of rawEntries) {
    if (entry.rootKind === 'canonical') continue;
    const canonical =
      entry.rootKind === 'tool' &&
      entry.folder === entry.name &&
      entry.linkTarget === join(paths.skillsDir, entry.name)
        ? canonicalByPath.get(entry.linkTarget)
        : undefined;
    if (canonical) {
      canonical.locations.push(entry.path);
      continue;
    }
    skills.push({
      name: entry.name,
      folder: entry.folder,
      path: entry.path,
      locations: [entry.path],
      managed: ownedPaths.has(entry.path) && ownedSkills.has(entry.name),
      plugin: entry.rootKind === 'plugin',
    });
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
    .filter((skill) => !skill.plugin && !skill.managed)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { skills, unmanaged, collisions, skipped };
}
