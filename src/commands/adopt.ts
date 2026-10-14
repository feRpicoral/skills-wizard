import { basename, join } from 'node:path';

import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { lstatIfExists, realLocation } from '../install/fs.ts';
import { type AdoptChoice, promptAdoptSkills } from '../prompts/selection.ts';
import {
  choiceHint,
  upstreamEntry,
  withCatalogEntries,
} from '../skills/adopt-catalog.ts';
import { catalogPath } from '../skills/catalog.ts';
import {
  type DiscoveredSkill,
  scanInstalledSkills,
} from '../skills/collisions.ts';
import {
  findSkill,
  loadSkillLibrary,
  type SkillLibrary,
} from '../skills/library.ts';
import { type LockedSkill, readSkillLock } from '../skills/lock.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  applyWithCatalogRollback,
  buildSyncPlanForLocation,
  loadLibrary,
  notify,
  readLocationManifest,
  resolveLocation,
} from './shared.ts';

export interface AdoptOptions {
  names: string[];
  tools?: ToolId[];
  yes: boolean;
  dryRun: boolean;
}

interface CheckFolderNamesParams {
  unmanaged: readonly DiscoveredSkill[];
  picked: readonly string[];
  home: string;
}

async function mismatchedFolders(skill: DiscoveredSkill): Promise<string[]> {
  const folders = new Set(skill.locations);
  for (const location of skill.locations) {
    const real = await realLocation(location);
    if (real) folders.add(real);
  }
  return [...folders].filter((path) => basename(path) !== skill.name);
}

async function checkFolderNames({
  unmanaged,
  picked,
  home,
}: CheckFolderNamesParams): Promise<void> {
  const details: string[] = [];
  for (const skill of unmanaged) {
    if (!picked.includes(skill.name)) continue;
    for (const path of await mismatchedFolders(skill)) {
      details.push(
        `${displayPath({ path, home })} declares the name ${skill.name}`,
      );
    }
  }
  if (details.length === 0) return;
  throw new UsageError(
    `Cannot adopt skills whose folder name differs from their name: ${details.join('; ')}. Rename or remove these folders first.`,
  );
}

interface PickUnmanagedSkillsParams {
  ctx: Context;
  prompting: boolean;
  names: readonly string[];
  unmanaged: readonly DiscoveredSkill[];
  skillLibrary: SkillLibrary;
  locked: ReadonlyMap<string, LockedSkill>;
}

async function pickUnmanagedSkills({
  ctx,
  prompting,
  names,
  unmanaged,
  skillLibrary,
  locked,
}: PickUnmanagedSkillsParams): Promise<string[] | null> {
  const unmanagedByName = new Map(
    unmanaged.map((skill) => [skill.name, skill]),
  );
  if (names.length > 0) {
    const missing = names.filter((name) => !unmanagedByName.has(name));
    if (missing.length > 0) {
      throw new UsageError(`Not an unmanaged skill: ${missing.join(', ')}`);
    }
    const unknown = names.filter(
      (name) =>
        !findSkill(skillLibrary, name) &&
        !upstreamEntry({ name, locked, catalog: skillLibrary.catalog }),
    );
    if (unknown.length > 0) {
      throw new UsageError(
        `Cannot adopt ${unknown.join(', ')}: no source in catalog.yaml, skills/ or ~/.agents/.skill-lock.json`,
      );
    }
    return [...new Set(names)];
  }

  const choices: AdoptChoice[] = [];
  const unsupported: string[] = [];
  for (const skill of unmanaged) {
    const hint = choiceHint({
      skill,
      library: skillLibrary,
      locked,
      home: ctx.paths.home,
    });
    if (hint) choices.push({ name: skill.name, hint });
    else unsupported.push(skill.name);
  }
  if (unsupported.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Skipping unmanaged skills without a known source: ${unsupported.join(', ')}`,
    });
  }
  if (choices.length === 0) {
    notify({
      ctx,
      prompting,
      message: 'No adoptable unmanaged skills found.',
    });
    return null;
  }
  if (!prompting) {
    throw new UsageError(
      'Pass the unmanaged skill names to adopt, for example: agents-config adopt pretty-mermaid',
    );
  }
  const picked = await promptAdoptSkills(choices);
  if (picked.length === 0) {
    notify({ ctx, prompting: true, message: 'Nothing was adopted.' });
    return null;
  }
  return picked;
}

export async function runAdopt(
  ctx: Context,
  { names, tools: requestedTools, yes, dryRun }: AdoptOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const location = await resolveLocation({ ctx, scope: 'global' });
  const previous = await readLocationManifest({ ctx, prompting, location });
  if (!previous) {
    throw new UsageError(
      'No system-wide install recorded; run agents-config init --global first.',
    );
  }
  const scan = await scanInstalledSkills(ctx.paths, previous);
  if (scan.unmanaged.length === 0) {
    notify({ ctx, prompting, message: 'No unmanaged skills found.' });
    return 0;
  }

  const locked = await readSkillLock(ctx.paths);
  let skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const picked = await pickUnmanagedSkills({
    ctx,
    prompting,
    names,
    unmanaged: scan.unmanaged,
    skillLibrary,
    locked,
  });
  if (!picked) return 0;

  await checkFolderNames({
    unmanaged: scan.unmanaged,
    picked,
    home: ctx.paths.home,
  });
  const candidates = picked.flatMap((name) => {
    if (findSkill(skillLibrary, name)) return [];
    const entry = upstreamEntry({
      name,
      locked,
      catalog: skillLibrary.catalog,
    });
    return entry ? [entry] : [];
  });
  const file = catalogPath(ctx.repoRoot);
  const additions = withCatalogEntries({
    library: skillLibrary,
    candidates,
    file,
  });
  skillLibrary = additions.library;

  const library = await loadLibrary(ctx);
  const tools = requestedTools ?? previous.tools;
  if (tools.length === 0) {
    throw new UsageError(
      'No tools recorded; pass --tools <ids> or run agents-config init --global.',
    );
  }
  const stamp = ctx.sources.now().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(ctx.paths.stateDir, 'backups', stamp);
  const plan = await buildSyncPlanForLocation({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
    tools,
    extraSkills: picked,
    adopt: { names: new Set(picked), backupDir },
  });

  const outcome = await applyWithCatalogRollback({
    ctx,
    prompting,
    plan,
    file,
    entries: additions.entries,
    manifestPath: location.manifestPath,
    yes,
    dryRun,
  });
  if (outcome.applied && (await lstatIfExists(backupDir))) {
    notify({
      ctx,
      prompting,
      message: `Backed up replaced skill files to ${displayPath({ path: backupDir, home: ctx.paths.home })}.`,
    });
  }
  return outcome.code;
}
