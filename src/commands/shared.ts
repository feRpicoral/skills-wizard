import { join } from 'node:path';

import * as clack from '@clack/prompts';

import {
  outOfScopeBlockIds,
  requiredVariables,
  selectBlocks,
  unknownBlockIds,
  withRequirements,
} from '../blocks/compose.ts';
import {
  type BlockLibrary,
  loadBlockLibrary,
  type Scope,
} from '../blocks/library.ts';
import {
  lookupVariables,
  type VariableLookupEnv,
} from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import { MissingVariablesError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { isPresetChoice, type PresetChoice } from '../project/presets.ts';
import { promptVariables } from '../prompts/selection.ts';
import { resolveSkillSources, type SkillSource } from '../skills/install.ts';
import {
  findSkill,
  type SkillLibrary,
  unknownSkillNames,
} from '../skills/library.ts';
import { readSkillLock, skillLockPath } from '../skills/lock.ts';
import type { SourceCache } from '../skills/sources.ts';
import type { Manifest } from '../state/manifest.ts';
import type { Location } from './location.ts';
import { notify, notifyLeftGit, setVariablesCommand } from './output.ts';

export {
  confirmAndApply,
  confirmAndApplyPlans,
  type ConfirmOptions,
  confirmPlan,
  confirmPlans,
  reportApplyOutcome,
} from './confirm.ts';
export {
  type Location,
  readLocationManifest,
  type ReadLocationManifestParams,
  resolveLocation,
  type ResolveLocationParams,
  warnTrackedFiles,
  type WarnTrackedFilesParams,
} from './location.ts';
export {
  notify,
  notifyLeftGit,
  type NotifyLeftGitParams,
  type NotifyParams,
  setVariablesCommand,
  type SetVariablesCommandParams,
} from './output.ts';

export async function loadLibrary(ctx: Context): Promise<BlockLibrary> {
  return loadBlockLibrary(join(ctx.repoRoot, 'blocks'));
}

const BLOCK_REPLACEMENT_SKILLS: Readonly<Record<string, string>> = {
  'git/github-repo-setup': 'github-repo-setup',
  'stack/supabase-prisma': 'supabase-prisma',
};

/**
 * Formats a parenthetical hint pointing to the replacement skill(s) when a
 * deprecated or out-of-scope block ID has a first-party skill equivalent.
 */
export function replacementSkillHint(ids: readonly string[]): string {
  const skills = [
    ...new Set(
      ids
        .map((id) => BLOCK_REPLACEMENT_SKILLS[id])
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (skills.length === 0) return '';
  return ` (use the ${skills.join(', ')} skill${skills.length === 1 ? '' : 's'} instead)`;
}

export interface DropUnknownPresetParams {
  ctx: Context;
  prompting: boolean;
  preset: string | undefined;
}

/**
 * Validates a recorded manifest `preset` value against `isPresetChoice`,
 * emitting a warning and returning `undefined` when it is no longer recognized.
 */
export function dropUnknownPreset({
  ctx,
  prompting,
  preset,
}: DropUnknownPresetParams): PresetChoice | undefined {
  if (preset === undefined) return undefined;
  if (isPresetChoice(preset)) return preset;
  notify({
    ctx,
    prompting,
    message: `Preset "${preset}" is no longer recognized and was dropped.`,
    level: 'warn',
  });
  return undefined;
}

export interface DropUnavailableBlocksParams {
  ctx: Context;
  prompting: boolean;
  library: BlockLibrary;
  ids: readonly string[];
  scope: Scope;
}

export function dropUnavailableBlocks({
  ctx,
  prompting,
  library,
  ids,
  scope,
}: DropUnavailableBlocksParams): string[] {
  const unknown = unknownBlockIds(library, ids);
  const outOfScope = outOfScopeBlockIds(library, ids, scope);
  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer in the library were dropped: ${unknown.join(', ')}${replacementSkillHint(unknown)}`,
      level: 'warn',
    });
  }
  if (outOfScope.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}${replacementSkillHint(outOfScope)}`,
      level: 'warn',
    });
  }
  return ids.filter((id) => !unknown.includes(id) && !outOfScope.includes(id));
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

export interface ReconcileManifestParams {
  manifest: Manifest;
  library: BlockLibrary;
  location: Location;
  lookupEnv?: VariableLookupEnv;
}

export interface ReconciledManifest {
  blocks: string[];
  unknownBlocks: string[];
  outOfScopeBlocks: string[];
  addedBlocks: string[];
  preset?: PresetChoice;
  unknownPreset?: string;
  keepLocal: boolean;
  leftGit: boolean;
  neededVariables: string[];
  missingVariables: string[];
  foundVariables: Record<string, string>;
  unresolvedVariables: string[];
}

export async function reconcileManifest({
  manifest,
  library,
  location,
  lookupEnv,
}: ReconcileManifestParams): Promise<ReconciledManifest> {
  const { scope } = location;
  const rawPreset = manifest.options.preset;
  const preset =
    rawPreset !== undefined && isPresetChoice(rawPreset)
      ? rawPreset
      : undefined;
  const unknownPreset =
    rawPreset !== undefined && preset === undefined ? rawPreset : undefined;
  const unknownBlocks = unknownBlockIds(library, manifest.blocks);
  const outOfScopeBlocks = outOfScopeBlockIds(library, manifest.blocks, scope);
  const known = manifest.blocks.filter(
    (id) => !unknownBlocks.includes(id) && !outOfScopeBlocks.includes(id),
  );
  const { ids: blocks, added: addedBlocks } = withRequirements(library, known);
  const recordedLocal = manifest.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  const leftGit = location.project !== undefined && recordedLocal && !keepLocal;
  const neededVariables = requiredVariables(
    selectBlocks(library, blocks, scope),
  );
  const missingVariables = neededVariables.filter(
    (name) => !manifest.variables[name]?.trim(),
  );
  const foundVariables = await lookupVariables(
    missingVariables,
    manifest.variables,
    lookupEnv,
  );
  const unresolvedVariables = missingVariables.filter(
    (name) => !foundVariables[name]?.trim(),
  );
  return {
    blocks,
    unknownBlocks,
    outOfScopeBlocks,
    addedBlocks,
    ...(preset !== undefined ? { preset } : {}),
    ...(unknownPreset !== undefined ? { unknownPreset } : {}),
    keepLocal,
    leftGit,
    neededVariables,
    missingVariables,
    foundVariables,
    unresolvedVariables,
  };
}

export interface NotifyReconciledBlocksParams {
  ctx: Context;
  prompting: boolean;
  scope: Scope;
  reconciled: ReconciledManifest;
}

export function notifyReconciledBlocks({
  ctx,
  prompting,
  scope,
  reconciled: { unknownBlocks, outOfScopeBlocks, addedBlocks },
}: NotifyReconciledBlocksParams): void {
  if (unknownBlocks.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer in the library were dropped: ${unknownBlocks.join(', ')}${replacementSkillHint(unknownBlocks)}`,
      level: 'warn',
    });
  }
  if (outOfScopeBlocks.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer available for ${scope} scope were dropped: ${outOfScopeBlocks.join(', ')}${replacementSkillHint(outOfScopeBlocks)}`,
      level: 'warn',
    });
  }
  if (addedBlocks.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${addedBlocks.join(', ')}`,
    });
  }
}

export interface ResolveVariablesParams {
  ctx: Context;
  prompting: boolean;
  location: Location;
  recorded: Readonly<Record<string, string>>;
  reconciled: ReconciledManifest;
}

// A block edited to use a new variable has no recorded value yet. Look it up
// (or ask for it) the way init does, and stop with the init command otherwise.
export async function resolveVariables({
  ctx,
  prompting,
  location,
  recorded,
  reconciled: { missingVariables, foundVariables, unresolvedVariables },
}: ResolveVariablesParams): Promise<Record<string, string>> {
  if (missingVariables.length === 0) return { ...recorded };
  if (prompting) {
    return {
      ...recorded,
      ...(await promptVariables(missingVariables, foundVariables)),
    };
  }
  if (unresolvedVariables.length > 0) {
    throw new MissingVariablesError(
      `The blocks now use variables with no recorded value: ${unresolvedVariables.join(', ')}. Set them with ${setVariablesCommand({ ctx, location, names: unresolvedVariables })}`,
    );
  }
  ctx.print(
    `Using looked-up values for new variables: ${missingVariables.map((name) => `${name}=${foundVariables[name] ?? ''}`).join(', ')}`,
  );
  return foundVariables;
}

export interface ReconcileManifestSelectionParams {
  ctx: Context;
  prompting: boolean;
  location: Location;
  previous: Manifest;
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  extraSkills?: readonly string[];
}

export interface ReconciledSelection {
  blocks: string[];
  skills: string[];
  variables: Record<string, string>;
  keepLocal: boolean;
  preset?: PresetChoice;
}

export async function reconcileManifestSelection({
  ctx,
  prompting,
  location,
  previous,
  library,
  skillLibrary,
  extraSkills = [],
}: ReconcileManifestSelectionParams): Promise<ReconciledSelection> {
  const reconciled = await reconcileManifest({
    manifest: previous,
    library,
    location,
    lookupEnv: { home: ctx.paths.home, searchPath: ctx.searchPath },
  });
  if (reconciled.unknownPreset !== undefined) {
    notify({
      ctx,
      prompting,
      message: `Preset "${reconciled.unknownPreset}" is no longer recognized and was dropped.`,
      level: 'warn',
    });
  }
  notifyReconciledBlocks({ ctx, prompting, scope: location.scope, reconciled });
  const variables = await resolveVariables({
    ctx,
    prompting,
    location,
    recorded: previous.variables,
    reconciled,
  });
  const priorSkills = dropUnknownSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.skills,
    scope: location.scope,
  });
  const skills = [...new Set([...priorSkills, ...extraSkills])];
  if (reconciled.leftGit && location.project) {
    notifyLeftGit({ ctx, prompting, projectDir: location.project.dir });
  }
  return {
    blocks: reconciled.blocks,
    skills,
    variables,
    keepLocal: reconciled.keepLocal,
    ...(reconciled.preset !== undefined ? { preset: reconciled.preset } : {}),
  };
}
