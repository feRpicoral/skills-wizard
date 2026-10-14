import * as clack from '@clack/prompts';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { resolveSkillSources, type SkillSource } from '../skills/install.ts';
import {
  findSkill,
  type SkillLibrary,
  unknownSkillNames,
} from '../skills/library.ts';
import { readSkillLock, skillLockPath } from '../skills/lock.ts';
import type { SourceCache } from '../skills/sources.ts';
import { notify } from './output.ts';

export function checkExplicitSkills(
  library: SkillLibrary,
  names: readonly string[],
  scope: Scope,
): void {
  const unknown = unknownSkillNames(library, names);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown skills: ${unknown.join(', ')}`);
  }
  const outOfScope = names.filter(
    (name) => !findSkill(library, name)?.scopes.includes(scope),
  );
  if (outOfScope.length > 0) {
    throw new UsageError(
      `Skills not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
}

export interface DropUnknownSkillsParams {
  ctx: Context;
  prompting: boolean;
  library: SkillLibrary;
  names: readonly string[];
  scope?: Scope;
}

export function dropUnknownSkills({
  ctx,
  prompting,
  library,
  names,
  scope,
}: DropUnknownSkillsParams): string[] {
  const unknown = unknownSkillNames(library, names);
  const outOfScope =
    scope !== undefined
      ? names.filter((name) => {
          const skill = findSkill(library, name);
          return skill !== undefined && !skill.scopes.includes(scope);
        })
      : [];
  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Skills no longer in catalog.yaml or skills/ were dropped: ${unknown.join(', ')}`,
      level: 'warn',
    });
  }
  if (outOfScope.length > 0 && scope !== undefined) {
    notify({
      ctx,
      prompting,
      message: `Skills no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}`,
      level: 'warn',
    });
  }
  return names.filter(
    (name) => !unknown.includes(name) && !outOfScope.includes(name),
  );
}

export function sourceCache(ctx: Context): SourceCache {
  return { root: ctx.paths.sourcesDir, ...ctx.sources };
}

export interface FetchSkillsParams {
  ctx: Context;
  prompting: boolean;
  library: SkillLibrary;
  names: readonly string[];
}

export async function fetchSkills({
  ctx,
  prompting,
  library,
  names,
}: FetchSkillsParams): Promise<Map<string, SkillSource>> {
  if (names.length === 0) return new Map();
  const spinner = prompting ? clack.spinner() : null;
  spinner?.start('Fetching skills');
  const { sources, problems } = await resolveSkillSources({
    library,
    names,
    cache: sourceCache(ctx),
    fetch: true,
  });
  spinner?.stop('Fetched skills');
  for (const [name, problem] of problems) {
    notify({
      ctx,
      prompting,
      message: `Skipping the ${name} skill: ${problem}`,
      level: 'warn',
    });
  }
  return sources;
}

export async function warnLockedSkills(
  ctx: Context,
  prompting: boolean,
  names: readonly string[],
): Promise<void> {
  const locked = await readSkillLock(ctx.paths);
  const shared = names.filter((name) => locked.has(name));
  if (shared.length > 0) {
    notify({
      ctx,
      prompting,
      message: `${displayPath({ path: skillLockPath(ctx.paths), home: ctx.paths.home })} also tracks ${shared.join(', ')}; the installer that wrote it may replace these copies.`,
      level: 'warn',
    });
  }
}
