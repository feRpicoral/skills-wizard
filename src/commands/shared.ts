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
import { readTextIfExists } from '../install/fs.ts';
import { buildPlan, type Plan } from '../install/plan.ts';
import {
  loadMcpCatalog,
  type McpCatalog,
  mcpCatalogPath,
} from '../mcp/model.ts';
import { isPresetChoice, type PresetChoice } from '../project/presets.ts';
import { promptVariables } from '../prompts/selection.ts';
import { appendEntries, restoreCatalog } from '../skills/adopt-catalog.ts';
import type { CatalogEntry } from '../skills/catalog.ts';
import {
  DEFAULT_SKILL_MODE,
  resolveSkillSources,
  type SkillSource,
} from '../skills/install.ts';
import type { SkillLibrary } from '../skills/library.ts';
import { readSkillLock, skillLockPath } from '../skills/lock.ts';
import type { SourceCache } from '../skills/sources.ts';
import type { Manifest } from '../state/manifest.ts';
import type { ToolId } from '../tools/registry.ts';
import { confirmAndApply } from './confirm.ts';
import { type Location, warnTrackedFiles } from './location.ts';
import { notify, notifyLeftGit, setVariablesCommand } from './output.ts';
import {
  dropUnavailableMcpServers,
  dropUnknownSkills,
  replacementSkillHint,
} from './prune.ts';

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
  checkExplicitMcp,
  type CheckExplicitMcpParams,
  dropUnavailableBlocks,
  type DropUnavailableBlocksParams,
  dropUnavailableMcpServers,
  type DropUnavailableMcpServersParams,
  dropUnknownPreset,
  type DropUnknownPresetParams,
  dropUnknownSkills,
  type DropUnknownSkillsParams,
  replacementSkillHint,
} from './prune.ts';

export async function loadLibrary(ctx: Context): Promise<BlockLibrary> {
  return loadBlockLibrary(join(ctx.repoRoot, 'blocks'));
}

export async function loadMcpServers(ctx: Context): Promise<McpCatalog> {
  return loadMcpCatalog(mcpCatalogPath(ctx.repoRoot));
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
  mcpCatalog?: McpCatalog;
  extraSkills?: readonly string[];
  mcpOverride?: readonly string[];
}

export interface ReconciledSelection {
  blocks: string[];
  skills: string[];
  mcp: string[];
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
  mcpCatalog,
  extraSkills = [],
  mcpOverride,
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
  const mcp =
    mcpOverride !== undefined
      ? [...mcpOverride]
      : mcpCatalog
        ? dropUnavailableMcpServers({
            ctx,
            prompting,
            catalog: mcpCatalog,
            names: previous.mcp ?? [],
            scope: location.scope,
          })
        : [...(previous.mcp ?? [])];
  if (reconciled.leftGit && location.project) {
    notifyLeftGit({ ctx, prompting, projectDir: location.project.dir });
  }
  return {
    blocks: reconciled.blocks,
    skills,
    mcp,
    variables,
    keepLocal: reconciled.keepLocal,
    ...(reconciled.preset !== undefined ? { preset: reconciled.preset } : {}),
  };
}

export interface BuildSyncPlanForLocationParams {
  ctx: Context;
  prompting: boolean;
  location: Location;
  previous: Manifest;
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  mcpCatalog?: McpCatalog;
  tools?: readonly ToolId[];
  extraSkills?: readonly string[];
  extraSkillSources?: ReadonlyMap<string, SkillSource>;
  mcpOverride?: readonly string[];
  warnLocked?: boolean;
  adopt?: { names: ReadonlySet<string>; backupDir: string };
}

/**
 * Reconciles a recorded manifest against the current block, skill, and MCP
 * libraries, resolves skill sources, and builds the install {@link Plan} for
 * `location`.
 */
export async function buildSyncPlanForLocation({
  ctx,
  prompting,
  location,
  previous,
  library,
  skillLibrary,
  mcpCatalog,
  tools = previous.tools,
  extraSkills = [],
  extraSkillSources,
  mcpOverride,
  warnLocked = false,
  adopt,
}: BuildSyncPlanForLocationParams): Promise<Plan> {
  const reconciled = await reconcileManifestSelection({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
    ...(mcpCatalog ? { mcpCatalog } : {}),
    extraSkills,
    ...(mcpOverride !== undefined ? { mcpOverride } : {}),
  });
  if (warnLocked && location.scope === 'global') {
    await warnLockedSkills(ctx, prompting, reconciled.skills);
  }
  const namesToFetch =
    tools.length > 0
      ? reconciled.skills.filter((name) => !extraSkillSources?.has(name))
      : [];
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: namesToFetch,
  });
  for (const [name, source] of extraSkillSources ?? []) {
    skillSources.set(name, source);
  }
  const plan = await buildPlan({
    scope: location.scope,
    selection: {
      tools: [...tools],
      blocks: reconciled.blocks,
      skills: reconciled.skills,
      mcp: reconciled.mcp,
      variables: reconciled.variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal: reconciled.keepLocal,
      skillMode: previous.options.skillMode ?? DEFAULT_SKILL_MODE,
      ...(reconciled.preset !== undefined ? { preset: reconciled.preset } : {}),
      ...(previous.options.style !== undefined
        ? { style: previous.options.style }
        : {}),
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
    skillSources,
    ...(mcpCatalog ? { mcpCatalog } : {}),
    ...(adopt ? { adopt } : {}),
  });
  if (reconciled.keepLocal) {
    await warnTrackedFiles({
      ctx,
      prompting,
      plan,
      ...(location.project ? { project: location.project } : {}),
    });
  }
  return plan;
}

export interface ApplyWithCatalogRollbackParams {
  ctx: Context;
  prompting: boolean;
  plan: Plan;
  file: string;
  entries: readonly CatalogEntry[];
  failureOutcome?: string;
  manifestPath: string;
  projectDir?: string;
  yes: boolean;
  dryRun: boolean;
}

export interface ApplyWithCatalogRollbackOutcome {
  code: number;
  applied: boolean;
  keptEntries: CatalogEntry[];
}

export async function applyWithCatalogRollback({
  ctx,
  prompting,
  plan,
  file,
  entries,
  failureOutcome,
  manifestPath,
  projectDir,
  yes,
  dryRun,
}: ApplyWithCatalogRollbackParams): Promise<ApplyWithCatalogRollbackOutcome> {
  let catalogBefore: string | null | undefined;
  const writeCatalog = async () => {
    if (entries.length === 0) return;
    const original = await readTextIfExists(file);
    await appendEntries(file, entries, failureOutcome);
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
        entries,
        manifestPath,
        ...(projectDir !== undefined ? { projectDir } : {}),
      });
    }
    throw error;
  }
  const keptEntries =
    catalogBefore !== undefined
      ? await restoreCatalog({
          file,
          original: catalogBefore,
          entries,
          manifestPath,
          ...(projectDir !== undefined ? { projectDir } : {}),
        })
      : [...entries];
  if (result.applied && keptEntries.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added to catalog.yaml: ${keptEntries.map((entry) => entry.name).join(', ')}`,
    });
  }
  return { code: result.code, applied: result.applied, keptEntries };
}
