import { basename, join } from 'node:path';

import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import {
  lstatIfExists,
  readTextIfExists,
  realLocation,
} from '../install/fs.ts';
import { buildPlan, type Plan } from '../install/plan.ts';
import { type AdoptChoice, promptAdoptSkills } from '../prompts/selection.ts';
import {
  appendEntries,
  choiceHint,
  restoreCatalog,
  upstreamEntry,
  withCatalogEntries,
} from '../skills/adopt-catalog.ts';
import { type CatalogEntry, catalogPath } from '../skills/catalog.ts';
import {
  type DiscoveredSkill,
  scanInstalledSkills,
} from '../skills/collisions.ts';
import { DEFAULT_SKILL_MODE } from '../skills/install.ts';
import {
  findSkill,
  loadSkillLibrary,
  type SkillLibrary,
} from '../skills/library.ts';
import { type LockedSkill, readSkillLock } from '../skills/lock.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  confirmAndApply,
  fetchSkills,
  loadLibrary,
  notify,
  readLocationManifest,
  reconcileManifestSelection,
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

interface ApplyAdoptPlanParams {
  ctx: Context;
  prompting: boolean;
  plan: Plan;
  file: string;
  newCatalogEntries: readonly CatalogEntry[];
  manifestPath: string;
  backupDir: string;
  yes: boolean;
  dryRun: boolean;
}

async function applyAdoptPlan({
  ctx,
  prompting,
  plan,
  file,
  newCatalogEntries,
  manifestPath,
  backupDir,
  yes,
  dryRun,
}: ApplyAdoptPlanParams): Promise<number> {
  let catalogBefore: string | null | undefined;
  const writeCatalog = async () => {
    if (newCatalogEntries.length === 0) return;
    const original = await readTextIfExists(file);
    await appendEntries(file, newCatalogEntries);
    catalogBefore = original;
  };
  let result;
  try {
    result = await confirmAndApply(ctx, plan, {
      yes,
      dryRun,
      beforeApply: writeCatalog,
    });
  } catch (error) {
    if (catalogBefore !== undefined) {
      await restoreCatalog({
        file,
        original: catalogBefore,
        entries: newCatalogEntries,
        manifestPath,
      });
    }
    throw error;
  }
  const keptEntries =
    catalogBefore !== undefined
      ? await restoreCatalog({
          file,
          original: catalogBefore,
          entries: newCatalogEntries,
          manifestPath,
        })
      : newCatalogEntries;
  if (result.applied && keptEntries.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added to catalog.yaml: ${keptEntries.map((entry) => entry.name).join(', ')}`,
    });
  }
  if (result.applied && (await lstatIfExists(backupDir))) {
    notify({
      ctx,
      prompting,
      message: `Backed up replaced skill files to ${displayPath({ path: backupDir, home: ctx.paths.home })}.`,
    });
  }
  return result.code;
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
  const reconciled = await reconcileManifestSelection({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
    extraSkills: picked,
  });
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: reconciled.skills,
  });

  const stamp = ctx.sources.now().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(ctx.paths.stateDir, 'backups', stamp);
  const plan = await buildPlan({
    scope: 'global',
    selection: {
      tools,
      blocks: reconciled.blocks,
      skills: reconciled.skills,
      variables: reconciled.variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal: false,
      skillMode: previous.options.skillMode ?? DEFAULT_SKILL_MODE,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    skillSources,
    adopt: { names: new Set(picked), backupDir },
  });

  return applyAdoptPlan({
    ctx,
    prompting,
    plan,
    file,
    newCatalogEntries: additions.entries,
    manifestPath: location.manifestPath,
    backupDir,
    yes,
    dryRun,
  });
}
