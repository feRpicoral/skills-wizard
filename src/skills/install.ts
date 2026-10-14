import { join } from 'node:path';

import { SourceError } from '../errors.ts';
import type { SkillSourceRecord } from '../state/manifest.ts';
import {
  type CatalogEntry,
  repositoryPaths,
  WHOLE_REPOSITORY,
} from './catalog.ts';
import { findSkill, type SkillLibrary } from './library.ts';
import {
  cachedSource,
  ensureSource,
  type SourceCache,
  sourceCommit,
} from './sources.ts';
import { hashTree } from './tree.ts';
import { validateSkill } from './validate.ts';

export const SKILL_MODES = ['copy', 'link'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export const DEFAULT_SKILL_MODE: SkillMode = 'copy';

export interface SkillSource {
  dir: string;
  record: SkillSourceRecord;
  linkable: boolean;
  setup?: string;
  hash?: string;
}

export interface SkillResolution {
  sources: Map<string, SkillSource>;
  problems: Map<string, string>;
}

async function checkedSource(
  name: string,
  source: SkillSource,
  resolution: SkillResolution,
): Promise<void> {
  const report = await validateSkill(source.dir, {
    strict: false,
    expectedName: name,
  });

  if (report.errors.length > 0) {
    resolution.problems.set(name, report.errors.join('; '));
  } else {
    const hash = source.hash ?? (await hashTree(source.dir));
    resolution.sources.set(name, { ...source, hash });
  }
}

interface ResolveRepositoryParams {
  library: SkillLibrary;
  entries: readonly CatalogEntry[];
  cache: SourceCache;
  fetch: boolean;
  resolution: SkillResolution;
}

async function resolveRepository({
  library,
  entries,
  cache,
  fetch,
  resolution,
}: ResolveRepositoryParams): Promise<void> {
  const [first] = entries;
  if (!first) return;

  const { repo, ref } = first;
  let root: string | null;
  let commit = '';

  try {
    root = fetch
      ? await ensureSource(cache, {
          repo,
          ref: ref || undefined,
          paths: repositoryPaths(library.catalog, repo),
        })
      : await cachedSource(cache, repo);
    if (root) commit = await sourceCommit(cache, repo);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;

    for (const entry of entries) {
      resolution.problems.set(entry.name, error.message);
    }

    return;
  }

  for (const entry of entries) {
    if (!root) {
      resolution.problems.set(
        entry.name,
        `${repo} has not been downloaded yet`,
      );
      continue;
    }

    await checkedSource(
      entry.name,
      {
        dir: entry.path === WHOLE_REPOSITORY ? root : join(root, entry.path),
        record: {
          type: 'catalog',
          repo,
          path: entry.path,
          ...(ref ? { ref } : {}),
          commit,
        },
        linkable: false,
        setup: entry.setup,
      },
      resolution,
    );
  }
}

export interface ResolveSkillSourcesParams {
  library: SkillLibrary;
  names: readonly string[];
  cache: SourceCache;
  fetch: boolean;
}

export async function resolveSkillSources({
  library,
  names,
  cache,
  fetch,
}: ResolveSkillSourcesParams): Promise<SkillResolution> {
  const resolution: SkillResolution = {
    sources: new Map(),
    problems: new Map(),
  };
  const repositories = new Map<string, CatalogEntry[]>();

  for (const name of names) {
    const skill = findSkill(library, name);

    if (skill?.origin.type === 'local') {
      await checkedSource(
        name,
        {
          dir: skill.origin.dir,
          record: { type: 'local', path: skill.origin.path },
          linkable: true,
        },
        resolution,
      );
    } else if (skill?.origin.type === 'catalog') {
      const { entry } = skill.origin;
      repositories.set(entry.repo, [
        ...(repositories.get(entry.repo) ?? []),
        entry,
      ]);
    }
  }

  for (const entries of repositories.values()) {
    await resolveRepository({
      library,
      entries,
      cache,
      fetch,
      resolution,
    });
  }

  return resolution;
}
