import { join } from 'node:path';

import { withRequirements } from '../blocks/compose.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { lstatIfExists } from '../install/fs.ts';
import { buildPlan } from '../install/plan.ts';
import { type AdoptChoice, promptAdoptSkills } from '../prompts/selection.ts';
import {
  appendCatalogEntries,
  type CatalogEntry,
  catalogPath,
  WHOLE_REPOSITORY,
} from '../skills/catalog.ts';
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
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  confirmAndApply,
  dropUnknownBlocks,
  dropUnknownSkills,
  fetchSkills,
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

const DEFAULT_ADOPT_CATEGORY = 'workflow';

function upstreamEntry(
  name: string,
  locked: ReadonlyMap<string, LockedSkill>,
): CatalogEntry | undefined {
  const info = locked.get(name);
  if (!info?.repo) return undefined;
  return {
    name,
    repo: info.repo,
    path: info.path ?? WHOLE_REPOSITORY,
    category: DEFAULT_ADOPT_CATEGORY,
    scopes: ['global', 'project'],
    defaults: [],
  };
}

interface ChoiceHintParams {
  skill: DiscoveredSkill;
  library: SkillLibrary;
  locked: ReadonlyMap<string, LockedSkill>;
  home: string;
}

function choiceHint({
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
  const entry = upstreamEntry(skill.name, locked);
  if (entry) return `${location} (${entry.repo}, adds to catalog.yaml)`;
  return null;
}

function withInMemoryEntries(
  library: SkillLibrary,
  entries: readonly CatalogEntry[],
): SkillLibrary {
  if (entries.length === 0) return library;
  return {
    catalog: {
      categories: {
        ...library.catalog.categories,
        [DEFAULT_ADOPT_CATEGORY]:
          library.catalog.categories[DEFAULT_ADOPT_CATEGORY] ??
          DEFAULT_ADOPT_CATEGORY,
      },
      skills: [...library.catalog.skills, ...entries],
    },
    skills: [
      ...library.skills,
      ...entries.map((entry) => ({
        name: entry.name,
        group: library.catalog.categories[entry.category] ?? entry.category,
        scopes: entry.scopes,
        defaults: entry.defaults,
        origin: { type: 'catalog' as const, entry },
      })),
    ],
  };
}

export async function runAdopt(
  ctx: Context,
  { names, tools: requestedTools, yes, dryRun }: AdoptOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const location = await resolveLocation({ ctx, scope: 'global' });
  const previous = await readLocationManifest(ctx, prompting, location);
  const scan = await scanInstalledSkills(ctx.paths, previous);
  if (scan.unmanaged.length === 0) {
    notify({ ctx, prompting, message: 'No unmanaged skills found.' });
    return 0;
  }

  const locked = await readSkillLock(ctx.paths);
  let skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const unmanagedByName = new Map(
    scan.unmanaged.map((skill) => [skill.name, skill]),
  );

  let picked: string[];
  if (names.length > 0) {
    const missing = names.filter((name) => !unmanagedByName.has(name));
    if (missing.length > 0) {
      throw new UsageError(`Not an unmanaged skill: ${missing.join(', ')}`);
    }
    const unknown = names.filter(
      (name) => !findSkill(skillLibrary, name) && !upstreamEntry(name, locked),
    );
    if (unknown.length > 0) {
      throw new UsageError(
        `Cannot adopt ${unknown.join(', ')}: no source in catalog.yaml, skills/ or ~/.agents/.skill-lock.json`,
      );
    }
    picked = [...new Set(names)];
  } else {
    const choices: AdoptChoice[] = [];
    const unsupported: string[] = [];
    for (const skill of scan.unmanaged) {
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
      return 0;
    }
    if (!prompting) {
      throw new UsageError(
        'Pass the unmanaged skill names to adopt, for example: agents-config adopt pretty-mermaid',
      );
    }
    picked = await promptAdoptSkills(choices);
    if (picked.length === 0) {
      notify({ ctx, prompting: true, message: 'Nothing was adopted.' });
      return 0;
    }
  }

  const newCatalogEntries = picked.flatMap((name) => {
    if (findSkill(skillLibrary, name)) return [];
    const entry = upstreamEntry(name, locked);
    return entry ? [entry] : [];
  });
  skillLibrary = withInMemoryEntries(skillLibrary, newCatalogEntries);

  const library = await loadLibrary(ctx);
  const tools =
    requestedTools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  if (tools.length === 0) {
    throw new UsageError(
      'No tools recorded or detected; run agents-config init first or pass --tools <ids>.',
    );
  }
  const knownBlocks = previous
    ? dropUnknownBlocks({
        ctx,
        prompting,
        library,
        ids: previous.blocks,
      })
    : [];
  const { ids: blocks } = withRequirements(library, knownBlocks);
  const priorSkills = previous
    ? dropUnknownSkills({
        ctx,
        prompting,
        library: skillLibrary,
        names: previous.skills,
      })
    : [];
  const skills = [...new Set([...priorSkills, ...picked])];
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: skills,
  });

  const stamp = ctx.sources.now().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(ctx.paths.stateDir, 'backups', stamp);
  const plan = await buildPlan({
    scope: 'global',
    selection: {
      tools,
      blocks,
      skills,
      variables: previous?.variables ?? {},
      linkCommand: previous?.options.linkCommand ?? false,
      keepLocal: false,
      skillMode: previous?.options.skillMode ?? DEFAULT_SKILL_MODE,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    skillSources,
    adopt: { names: new Set(picked), backupDir },
  });

  const result = await confirmAndApply(ctx, plan, { yes, dryRun });
  if (result.applied && newCatalogEntries.length > 0) {
    await appendCatalogEntries(catalogPath(ctx.repoRoot), newCatalogEntries);
    notify({
      ctx,
      prompting,
      message: `Added to catalog.yaml: ${newCatalogEntries.map((entry) => entry.name).join(', ')}`,
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
