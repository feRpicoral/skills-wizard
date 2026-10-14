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
import type { Manifest } from '../state/manifest.ts';
import type { Location } from './location.ts';
import { notify } from './output.ts';

export {
  confirmAndApply,
  type ConfirmOptions,
  confirmPlan,
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
