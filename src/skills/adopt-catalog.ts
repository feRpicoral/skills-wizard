import { CatalogError, isSystemError, UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { fsErrorReason, removePath, writeTextAtomic } from '../install/fs.ts';
import { readManifest } from '../state/manifest.ts';
import {
  appendCatalogEntries,
  type Catalog,
  type CatalogEntry,
  extendCatalog,
  WHOLE_REPOSITORY,
} from './catalog.ts';
import type { DiscoveredSkill } from './collisions.ts';
import { extendSkillLibrary, findSkill, type SkillLibrary } from './library.ts';
import type { LockedSkill } from './lock.ts';

const DEFAULT_ADOPT_CATEGORY = 'workflow';

export interface UpstreamEntryParams {
  name: string;
  locked: ReadonlyMap<string, LockedSkill>;
  catalog: Catalog;
}

export function upstreamEntry({
  name,
  locked,
  catalog,
}: UpstreamEntryParams): CatalogEntry | undefined {
  const info = locked.get(name);

  if (!info?.repo) return undefined;

  const ref = catalog.skills.find((entry) => entry.repo === info.repo)?.ref;

  return {
    name,
    repo: info.repo,
    path: info.path ?? WHOLE_REPOSITORY,
    ...(ref ? { ref } : {}),
    category: DEFAULT_ADOPT_CATEGORY,
    scopes: ['global', 'project'],
    defaults: [],
  };
}

export interface ChoiceHintParams {
  skill: DiscoveredSkill;
  library: SkillLibrary;
  locked: ReadonlyMap<string, LockedSkill>;
  home: string;
}

export function choiceHint({
  skill,
  library,
  locked,
  home,
}: ChoiceHintParams): string | null {
  const location = skill.locations
    .map((path) => displayPath({ path, home }))
    .join(', ');
  const existing = findSkill(library, skill.name);

  if (existing) {
    const source =
      existing.origin.type === 'local'
        ? existing.origin.path
        : existing.origin.entry.repo;
    return `${location} (${source})`;
  }

  const entry = upstreamEntry({
    name: skill.name,
    locked,
    catalog: library.catalog,
  });

  if (entry) return `${location} (${entry.repo}, adds to catalog.yaml)`;

  return null;
}

export interface CatalogAdditions {
  library: SkillLibrary;
  entries: CatalogEntry[];
}

export interface WithCatalogEntriesParams {
  library: SkillLibrary;
  candidates: readonly CatalogEntry[];
  file: string;
}

export function withCatalogEntries({
  library,
  candidates,
  file,
}: WithCatalogEntriesParams): CatalogAdditions {
  if (candidates.length === 0) return { library, entries: [] };

  let catalog: Catalog;

  try {
    catalog = extendCatalog({
      catalog: library.catalog,
      entries: candidates,
      file,
    });
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;

    throw new UsageError(
      `Cannot adopt ${candidates.map((entry) => entry.name).join(', ')} from ~/.agents/.skill-lock.json: ${error.message}`,
      { cause: error },
    );
  }

  const entries = catalog.skills.slice(library.catalog.skills.length);

  return {
    entries,
    library: extendSkillLibrary(library, catalog),
  };
}

export async function appendEntries(
  file: string,
  entries: readonly CatalogEntry[],
  failureOutcome = 'nothing was adopted',
): Promise<void> {
  try {
    await appendCatalogEntries(file, entries);
  } catch (error) {
    if (!isSystemError(error)) throw error;

    throw new CatalogError(
      `Could not update ${file} (${fsErrorReason(error) ?? error.message}), so ${failureOutcome}.`,
      { cause: error },
    );
  }
}

export interface RestoreCatalogParams {
  file: string;
  original: string | null;
  entries: readonly CatalogEntry[];
  manifestPath: string;
}

// A failed or conflicted apply may still have recorded some skills in the
// manifest (actions that ran are kept), so only the entries without an
// installed skill entry in the manifest are taken back out of catalog.yaml.
export async function restoreCatalog({
  file,
  original,
  entries,
  manifestPath,
}: RestoreCatalogParams): Promise<CatalogEntry[]> {
  let recorded: ReadonlySet<string>;

  try {
    const manifest = await readManifest(manifestPath);
    recorded = new Set(
      (manifest?.entries ?? []).flatMap((entry) =>
        entry.kind === 'skill' ? [entry.name] : [],
      ),
    );
  } catch {
    return [...entries];
  }

  const kept = entries.filter((entry) => recorded.has(entry.name));

  if (kept.length === entries.length) return kept;

  if (original === null) await removePath(file);
  else await writeTextAtomic({ path: file, content: original });
  if (kept.length > 0) await appendCatalogEntries(file, kept);

  return kept;
}
