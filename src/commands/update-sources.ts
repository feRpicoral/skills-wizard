import type { Context } from '../context.ts';
import { SourceError } from '../errors.ts';
import { type CatalogEntry, repositoryPaths } from '../skills/catalog.ts';
import { findSkill, type SkillLibrary } from '../skills/library.ts';
import {
  checkSource,
  ensureSource,
  restoreSource,
  type SourceCache,
  type SourceSpec,
  updateSource,
} from '../skills/sources.ts';
import { notify } from './shared.ts';

export interface MovedSource {
  repo: string;
  commit: string;
}

export interface RefreshCatalogSourcesParams {
  ctx: Context;
  prompting: boolean;
  skillLibrary: SkillLibrary;
  names: readonly string[];
  cache: SourceCache;
}

export async function refreshCatalogSources({
  ctx,
  prompting,
  skillLibrary,
  names,
  cache,
}: RefreshCatalogSourcesParams): Promise<MovedSource[]> {
  const specs = new Map<string, SourceSpec>();
  for (const name of names) {
    const skill = findSkill(skillLibrary, name);
    if (skill?.origin.type !== 'catalog') continue;
    const entry: CatalogEntry = skill.origin.entry;
    if (!specs.has(entry.repo)) {
      specs.set(entry.repo, {
        repo: entry.repo,
        ...(entry.ref ? { ref: entry.ref } : {}),
        paths: repositoryPaths(skillLibrary.catalog, entry.repo),
      });
    }
  }

  const moved: MovedSource[] = [];
  for (const spec of specs.values()) {
    try {
      await ensureSource(cache, spec);
      const check = await checkSource(cache, spec, { force: true });
      if (check.current !== check.latest) {
        const updated = await updateSource(cache, spec);
        if (updated.previous !== updated.current) {
          moved.push({ repo: spec.repo, commit: updated.previous });
        }
      }
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      notify({ ctx, prompting, message: error.message, level: 'warn' });
    }
  }
  return moved;
}

export interface RestoreMovedParams {
  ctx: Context;
  prompting: boolean;
  cache: SourceCache;
  moved: readonly MovedSource[];
}

export async function restoreMoved({
  ctx,
  prompting,
  cache,
  moved,
}: RestoreMovedParams): Promise<void> {
  for (const item of moved) {
    try {
      await restoreSource({ cache, repo: item.repo, commit: item.commit });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      notify({ ctx, prompting, message: error.message, level: 'warn' });
    }
  }
}
