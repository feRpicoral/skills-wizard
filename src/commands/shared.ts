import { join } from 'node:path';

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
import { promptVariables } from '../prompts/selection.ts';
import type { SkillLibrary } from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import type { Location } from './location.ts';
import { notify, notifyLeftGit, setVariablesCommand } from './output.ts';
import {
  dropUnknownSkills,
  type DropUnknownSkillsParams,
  fetchSkills,
  type FetchSkillsParams,
  sourceCache,
  warnLockedSkills,
} from './skill-shared.ts';

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
export {
  dropUnknownSkills,
  type DropUnknownSkillsParams,
  fetchSkills,
  type FetchSkillsParams,
  sourceCache,
  warnLockedSkills,
};

export async function loadLibrary(ctx: Context): Promise<BlockLibrary> {
  return loadBlockLibrary(join(ctx.repoRoot, 'blocks'));
}

export interface ReconcileManifestParams {
  manifest: Manifest;
  library: BlockLibrary;
  location: Location;
  lookupEnv?: VariableLookupEnv;
}

export interface ReconciledManifest {
  knownBlocks: string[];
  blocks: string[];
  unknownBlocks: string[];
  outOfScopeBlocks: string[];
  addedBlocks: string[];
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
  const unknownBlocks = unknownBlockIds(library, manifest.blocks);
  const outOfScopeBlocks = outOfScopeBlockIds(library, manifest.blocks, scope);
  const knownBlocks = manifest.blocks.filter(
    (id) => !unknownBlocks.includes(id) && !outOfScopeBlocks.includes(id),
  );
  const { ids: blocks, added: addedBlocks } = withRequirements(
    library,
    knownBlocks,
  );
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
    knownBlocks,
    blocks,
    unknownBlocks,
    outOfScopeBlocks,
    addedBlocks,
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
  reconciled: Pick<
    ReconciledManifest,
    'unknownBlocks' | 'outOfScopeBlocks' | 'addedBlocks'
  >;
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
      message: `Blocks no longer in the library were dropped: ${unknownBlocks.join(', ')}`,
      level: 'warn',
    });
  }
  if (outOfScopeBlocks.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer available for ${scope} scope were dropped: ${outOfScopeBlocks.join(', ')}`,
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
  };
}
