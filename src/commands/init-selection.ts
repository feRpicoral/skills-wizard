import {
  defaultBlockIds,
  outOfScopeBlockIds,
  requiredVariables,
  selectBlocks,
  unknownBlockIds,
  withRequirements,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import { lookupVariables } from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import {
  defaultMcpServerNames,
  detectedMcpServerNames,
  type McpCatalog,
} from '../mcp/model.ts';
import {
  applyReRunPresetAndStyle,
  applyReRunPresetSkills,
  type PresetChoice,
  type PresetDefinition,
  type ProjectStyle,
  type ResolvedPresetSelection,
} from '../project/presets.ts';
import {
  promptBlocks,
  promptKeepLocal,
  promptMcpServers,
  promptSkillMode,
  promptSkills,
  promptTools,
  promptVariables,
} from '../prompts/selection.ts';
import { DEFAULT_SKILL_MODE, type SkillMode } from '../skills/install.ts';
import {
  blockSkillNames,
  defaultSkillNames,
  findSkill,
  type SkillLibrary,
} from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  checkExplicitMcp,
  dropUnavailableMcpServers,
  dropUnknownSkills,
  type Location,
  notify,
  notifyLeftGit,
  notifyReconciledBlocks,
  type ReconciledManifest,
} from './shared.ts';
import { checkExplicitSkills } from './skill-shared.ts';

function checkExplicitBlocks(
  library: BlockLibrary,
  ids: readonly string[],
  scope: Scope,
): void {
  const unknown = unknownBlockIds(library, ids);

  if (unknown.length > 0) {
    throw new UsageError(`Unknown blocks: ${unknown.join(', ')}`);
  }

  const outOfScope = outOfScopeBlockIds(library, ids, scope);

  if (outOfScope.length > 0) {
    throw new UsageError(
      `Blocks not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
}

export interface ResolveToolsSelectionParams {
  ctx: Context;
  scope: Scope;
  prompting: boolean;
  requestedTools?: ToolId[];
  previous: Manifest | null;
  remembered?: ToolId[] | undefined;
}

export async function resolveToolsSelection({
  ctx,
  scope,
  prompting,
  requestedTools,
  previous,
  remembered,
}: ResolveToolsSelectionParams): Promise<ToolId[]> {
  const initial =
    remembered ??
    requestedTools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  const tools = prompting
    ? await promptTools({ scope, initial, paths: ctx.paths })
    : initial;

  if (!prompting && tools.length === 0 && !previous) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  return tools;
}

export interface ResolveBlocksSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  prompting: boolean;
  requestedBlocks?: string[];
  preset?: PresetChoice;
  style?: ProjectStyle;
  presetChanged: boolean;
  styleChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition | undefined;
  reconciled: ReconciledManifest | null;
  remembered?: string[] | undefined;
}

export async function resolveBlocksSelection({
  ctx,
  library,
  scope,
  prompting,
  requestedBlocks,
  preset,
  style,
  presetChanged,
  styleChanged,
  presetSelection,
  replacedPreset,
  reconciled,
  remembered,
}: ResolveBlocksSelectionParams): Promise<string[]> {
  if (requestedBlocks) checkExplicitBlocks(library, requestedBlocks, scope);

  if (!requestedBlocks && reconciled) {
    notifyReconciledBlocks({
      ctx,
      prompting,
      scope,
      reconciled:
        prompting || presetSelection !== null
          ? { ...reconciled, addedBlocks: [] }
          : reconciled,
    });

    if (!prompting && presetSelection === null) return reconciled.blocks;
  }

  const reRunBlocks =
    reconciled !== null && presetSelection !== null
      ? applyReRunPresetAndStyle({
          library,
          recordedBlocks: reconciled.knownBlocks,
          previousPresetBlocks: replacedPreset?.blocks ?? [],
          presetBlocks: presetChanged ? presetSelection.blocks : [],
          requestedStyle: styleChanged ? style : undefined,
        })
      : null;
  const initial =
    remembered ??
    requestedBlocks ??
    initialBlocks({
      library,
      scope,
      prompting,
      preset,
      reRunBlocks,
      reconciled,
      presetSelection,
    });
  const chosen = prompting
    ? await promptBlocks({ library, scope, initial })
    : initial;
  const { ids: blocks, added } = withRequirements(library, chosen);

  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }

  return blocks;
}

function initialBlocks({
  library,
  scope,
  prompting,
  preset,
  reRunBlocks,
  reconciled,
  presetSelection,
}: {
  library: BlockLibrary;
  scope: Scope;
  prompting: boolean;
  preset?: PresetChoice;
  reRunBlocks: string[] | null;
  reconciled: ReconciledManifest | null;
  presetSelection: ResolvedPresetSelection | null;
}): string[] {
  if (reRunBlocks !== null) {
    if (prompting && preset === 'none' && reRunBlocks.length === 0) {
      return defaultBlockIds(library, scope);
    }

    return reRunBlocks;
  }

  if (reconciled !== null) return reconciled.knownBlocks;
  if (presetSelection !== null && presetSelection.blocks.length > 0) {
    return presetSelection.blocks;
  }

  return defaultBlockIds(library, scope);
}

export interface ResolveVariablesSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  blocks: readonly string[];
  prompting: boolean;
  givenVariables: Readonly<Record<string, string>>;
  previous: Manifest | null;
  reconciled: ReconciledManifest | null;
  remembered?: Record<string, string> | undefined;
}

export async function resolveVariablesSelection({
  ctx,
  library,
  scope,
  blocks,
  prompting,
  givenVariables,
  previous,
  reconciled,
  remembered,
}: ResolveVariablesSelectionParams): Promise<Record<string, string>> {
  const needed = requiredVariables(selectBlocks(library, blocks, scope));
  const unused = Object.keys(givenVariables).filter(
    (name) => !needed.includes(name),
  );

  if (unused.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Ignoring unused variables: ${unused.join(', ')}`,
      level: 'warn',
    });
  }

  const known = await lookupVariables(
    needed,
    {
      ...previous?.variables,
      ...reconciled?.foundVariables,
      ...givenVariables,
    },
    { home: ctx.paths.home, searchPath: ctx.searchPath },
  );
  const variables = prompting
    ? await promptVariables(needed, { ...known, ...remembered })
    : known;
  const missing = needed.filter((name) => !variables[name]?.trim());

  if (missing.length > 0) {
    throw new UsageError(
      `Missing variables: ${missing.map((name) => `--var ${name}=<value>`).join(' ')}`,
    );
  }

  return variables;
}

export interface ResolveInstallOptionsParams {
  ctx: Context;
  scope: Scope;
  location: Location;
  prompting: boolean;
  requestedKeepLocal?: boolean;
  previous: Manifest | null;
  reconciled: ReconciledManifest | null;
  remembered?: boolean | undefined;
}

export async function resolveInstallOptions({
  ctx,
  scope,
  location,
  prompting,
  requestedKeepLocal,
  reconciled,
  remembered,
}: ResolveInstallOptionsParams): Promise<{
  keepLocal: boolean;
}> {
  const git = location.project?.git;

  if (requestedKeepLocal && !git) {
    throw new UsageError(
      `${location.project?.dir ?? ctx.cwd} is not in a git repository, so files cannot be kept local.`,
    );
  }

  if (
    reconciled?.leftGit &&
    location.project &&
    requestedKeepLocal === undefined
  ) {
    notifyLeftGit({ ctx, prompting, projectDir: location.project.dir });
  }

  const keepLocal =
    scope === 'project' && git
      ? await resolveKeepLocal({
          prompting,
          requestedKeepLocal,
          previousLocal: remembered ?? reconciled?.keepLocal ?? false,
        })
      : false;

  return { keepLocal };
}

async function resolveKeepLocal({
  prompting,
  requestedKeepLocal,
  previousLocal,
}: {
  prompting: boolean;
  requestedKeepLocal?: boolean;
  previousLocal: boolean;
}): Promise<boolean> {
  if (requestedKeepLocal !== undefined) return requestedKeepLocal;
  if (!prompting) return previousLocal;

  return promptKeepLocal(previousLocal);
}

export interface ResolveSkillsSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  scope: Scope;
  blocks: readonly string[];
  prompting: boolean;
  requestedSkills?: string[];
  presetChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition | undefined;
  previous: Manifest | null;
  remembered?: string[] | undefined;
}

/**
 * Resolves the skills to install. Without `--skills`, the starting selection
 * is the recorded, preset or default skills plus the skills suggested by blocks
 * that were not selected the last time (every selected block on a first run),
 * minus the skills of blocks that are no longer selected.
 */
export async function resolveSkillsSelection({
  ctx,
  library,
  skillLibrary,
  scope,
  blocks,
  prompting,
  requestedSkills,
  presetChanged,
  presetSelection,
  replacedPreset,
  previous,
  remembered,
}: ResolveSkillsSelectionParams): Promise<string[]> {
  if (requestedSkills) {
    checkExplicitSkills(skillLibrary, requestedSkills, scope);
  }

  const recordedSkills = previous
    ? dropUnknownSkills({
        ctx,
        prompting,
        library: skillLibrary,
        names: previous.skills,
        scope,
      })
    : null;
  const initialSkills =
    remembered ??
    requestedSkills ??
    withBlockSkills({
      library,
      skillLibrary,
      scope,
      blocks,
      recordedBlocks: previous?.blocks ?? [],
      presetSkills: presetSelection?.skills ?? [],
      skills: initialSkillNames({
        skillLibrary,
        scope,
        recordedSkills,
        presetChanged,
        presetSelection,
        replacedPreset,
      }),
    });

  return prompting
    ? promptSkills(skillLibrary, scope, initialSkills)
    : initialSkills;
}

interface WithBlockSkillsParams {
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  scope: Scope;
  blocks: readonly string[];
  recordedBlocks: readonly string[];
  presetSkills: readonly string[];
  skills: readonly string[];
}

/**
 * Adds the skills of blocks selected since the last install and removes the
 * skills of blocks no longer selected, unless a selected block or the preset
 * still suggests them.
 */
function withBlockSkills({
  library,
  skillLibrary,
  scope,
  blocks,
  recordedBlocks,
  presetSkills,
  skills,
}: WithBlockSkillsParams): string[] {
  const suggested = (blockIds: readonly string[]) =>
    blockSkillNames({
      library: skillLibrary,
      blocks: library,
      blockIds,
      scope,
    });
  const recorded = new Set(recordedBlocks);
  const selected = new Set(blocks);
  const kept = new Set([...suggested(blocks), ...presetSkills]);
  const dropped = new Set(
    suggested(recordedBlocks.filter((id) => !selected.has(id))).filter(
      (name) => !kept.has(name),
    ),
  );
  const added = suggested(blocks.filter((id) => !recorded.has(id)));

  return [
    ...new Set([...skills.filter((name) => !dropped.has(name)), ...added]),
  ];
}

export interface ResolveSkillModeSelectionParams {
  skillLibrary: SkillLibrary;
  scope: Scope;
  skills: readonly string[];
  prompting: boolean;
  requestedSkillMode?: SkillMode;
  previous: Manifest | null;
  remembered?: SkillMode | undefined;
}

export async function resolveSkillModeSelection({
  skillLibrary,
  scope,
  skills,
  prompting,
  requestedSkillMode,
  previous,
  remembered,
}: ResolveSkillModeSelectionParams): Promise<SkillMode> {
  if (scope !== 'global') return DEFAULT_SKILL_MODE;
  if (requestedSkillMode !== undefined) return requestedSkillMode;

  const previousMode = previous?.options.skillMode ?? DEFAULT_SKILL_MODE;
  const firstParty = skills.some(
    (name) => findSkill(skillLibrary, name)?.origin.type === 'local',
  );

  if (prompting && firstParty) {
    return promptSkillMode(remembered ?? previousMode);
  }

  return previousMode;
}

function initialSkillNames({
  skillLibrary,
  scope,
  recordedSkills,
  presetChanged,
  presetSelection,
  replacedPreset,
}: {
  skillLibrary: SkillLibrary;
  scope: Scope;
  recordedSkills: string[] | null;
  presetChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition;
}): string[] {
  if (recordedSkills !== null) {
    if (!presetChanged || presetSelection === null) return recordedSkills;

    return applyReRunPresetSkills({
      recordedSkills,
      previousPresetSkills: replacedPreset?.skills ?? [],
      presetSkills: presetSelection.skills,
    });
  }

  if (presetSelection !== null) return presetSelection.skills;

  return defaultSkillNames(skillLibrary, scope);
}

export interface ResolveMcpSelectionParams {
  ctx: Context;
  mcpCatalog: McpCatalog;
  scope: Scope;
  prompting: boolean;
  requestedMcp?: string[];
  location: Location;
  previous: Manifest | null;
  remembered?: string[] | undefined;
}

export async function resolveMcpSelection({
  ctx,
  mcpCatalog,
  scope,
  prompting,
  requestedMcp,
  location,
  previous,
  remembered,
}: ResolveMcpSelectionParams): Promise<string[]> {
  if (requestedMcp) {
    checkExplicitMcp({ catalog: mcpCatalog, names: requestedMcp, scope });
  }

  const recordedMcp = previous
    ? dropUnavailableMcpServers({
        ctx,
        prompting,
        catalog: mcpCatalog,
        names: previous.mcp,
        scope,
      })
    : null;
  const detectedMcp =
    scope === 'project'
      ? detectedMcpServerNames(
          mcpCatalog,
          location.detection?.detectedMcpServers ?? [],
        )
      : [];
  const projectMcp = [
    ...new Set([
      ...defaultMcpServerNames(mcpCatalog, 'project'),
      ...detectedMcp,
    ]),
  ];
  const fallbackMcp =
    scope === 'project' ? projectMcp : defaultMcpServerNames(mcpCatalog, scope);
  const initialMcp = remembered ?? requestedMcp ?? recordedMcp ?? fallbackMcp;

  return prompting
    ? promptMcpServers({
        catalog: mcpCatalog,
        scope,
        initial: initialMcp,
      })
    : initialMcp;
}
