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
import { ManifestError, UsageError } from '../errors.ts';
import {
  defaultMcpServerNames,
  detectedMcpServerNames,
  type McpCatalog,
} from '../mcp/model.ts';
import {
  applyReRunPresetAndStyle,
  applyReRunPresetSkills,
  findPreset,
  loadPresetsIfAvailable,
  type PresetChoice,
  type PresetDefinition,
  type ProjectStyle,
  type ResolvedPresetSelection,
  resolvePresetSelection,
  resolveProjectPresetAndStyle,
} from '../project/presets.ts';
import {
  promptBlocks,
  promptKeepLocal,
  promptLinkCommand,
  promptMcpServers,
  promptSkillMode,
  promptSkills,
  promptTools,
  promptVariables,
} from '../prompts/selection.ts';
import { DEFAULT_SKILL_MODE, type SkillMode } from '../skills/install.ts';
import {
  defaultSkillNames,
  findSkill,
  type SkillLibrary,
  unknownSkillNames,
} from '../skills/library.ts';
import {
  globalManifestPath,
  type Manifest,
  readGlobalManifest,
} from '../state/manifest.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  checkExplicitMcp,
  dropUnavailableBlocks,
  dropUnavailableMcpServers,
  dropUnknownPreset,
  dropUnknownSkills,
  type Location,
  notify,
  notifyLeftGit,
} from './shared.ts';

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

function checkExplicitSkills(
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

async function readGlobalManifestForProject(
  ctx: Context,
  prompting: boolean,
): Promise<Manifest | null> {
  try {
    return await readGlobalManifest(globalManifestPath(ctx.paths));
  } catch (error) {
    if (error instanceof ManifestError) {
      notify({
        ctx,
        prompting,
        message: `Skipping corrupt system-wide manifest when detecting default project style: ${error.message}`,
        level: 'warn',
      });
      return null;
    }
    throw error;
  }
}

export interface ResolveToolsSelectionParams {
  ctx: Context;
  scope: Scope;
  prompting: boolean;
  requestedTools?: ToolId[];
  previous: Manifest | null;
}

export async function resolveToolsSelection({
  ctx,
  scope,
  prompting,
  requestedTools,
  previous,
}: ResolveToolsSelectionParams): Promise<ToolId[]> {
  const initial =
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

export interface ResolveProjectPresetContextParams {
  ctx: Context;
  scope: Scope;
  prompting: boolean;
  tools: readonly ToolId[];
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  location: Location;
  previous: Manifest | null;
  requestedPreset: PresetChoice | undefined;
  requestedStyle: ProjectStyle | undefined;
}

export interface ResolvedProjectPresetContext {
  preset: PresetChoice | undefined;
  style: ProjectStyle | undefined;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset: PresetDefinition | undefined;
}

export async function resolveProjectPresetContext({
  ctx,
  scope,
  prompting,
  tools,
  library,
  skillLibrary,
  location,
  previous,
  requestedPreset,
  requestedStyle,
}: ResolveProjectPresetContextParams): Promise<ResolvedProjectPresetContext> {
  if (scope !== 'project') {
    return {
      preset: undefined,
      style: undefined,
      presetSelection: null,
      replacedPreset: undefined,
    };
  }

  const presets = await loadPresetsIfAvailable(ctx.repoRoot, {
    blockLibrary: library,
    skillLibrary,
  });
  const globalManifest = await readGlobalManifestForProject(ctx, prompting);
  const hasGlobalInstall =
    globalManifest !== null &&
    tools.length > 0 &&
    tools.every((tool) => globalManifest.tools.includes(tool));
  const previousPreset = previous
    ? dropUnknownPreset({
        ctx,
        prompting,
        preset: previous.options.preset,
      })
    : undefined;
  const { preset, style } = await resolveProjectPresetAndStyle({
    scope,
    prompting,
    hasGlobalInstall,
    presets,
    detection: location.detection,
    previous,
    previousPreset,
    requestedPreset,
    requestedStyle,
  });

  const usePresetDefaults =
    requestedPreset !== undefined ||
    requestedStyle !== undefined ||
    (previous === null &&
      ((preset !== undefined && preset !== 'none') ||
        style !== undefined ||
        (location.detection?.detectedBlocks.length ?? 0) > 0 ||
        (location.detection?.detectedSkills.length ?? 0) > 0));
  const presetSelection = usePresetDefaults
    ? resolvePresetSelection({
        preset: findPreset(presets, preset),
        style: style ?? (hasGlobalInstall ? 'lean' : 'self-contained'),
        blockLibrary: library,
        skillLibrary,
        ...(location.detection?.packageManager !== undefined
          ? { packageManager: location.detection.packageManager }
          : {}),
        detectedBlocks: location.detection?.detectedBlocks ?? [],
        detectedSkills: location.detection?.detectedSkills ?? [],
      })
    : null;
  const replacedPreset =
    previous !== null &&
    requestedPreset !== undefined &&
    previousPreset !== undefined &&
    previousPreset !== requestedPreset
      ? findPreset(presets, previousPreset)
      : undefined;

  return { preset, style, presetSelection, replacedPreset };
}

export interface ResolveBlocksSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  prompting: boolean;
  requestedBlocks?: string[];
  requestedPreset?: PresetChoice;
  requestedStyle?: ProjectStyle;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition;
  previous: Manifest | null;
}

export async function resolveBlocksSelection({
  ctx,
  library,
  scope,
  prompting,
  requestedBlocks,
  requestedPreset,
  requestedStyle,
  presetSelection,
  replacedPreset,
  previous,
}: ResolveBlocksSelectionParams): Promise<string[]> {
  if (requestedBlocks) checkExplicitBlocks(library, requestedBlocks, scope);
  const recordedBlocks = previous
    ? dropUnavailableBlocks({
        ctx,
        prompting,
        library,
        ids: previous.blocks,
        scope,
      })
    : null;
  const initial =
    requestedBlocks ??
    (recordedBlocks !== null
      ? presetSelection !== null
        ? applyReRunPresetAndStyle({
            library,
            recordedBlocks,
            previousPresetBlocks: replacedPreset?.blocks ?? [],
            presetBlocks:
              requestedPreset !== undefined ? presetSelection.blocks : [],
            requestedStyle,
          })
        : recordedBlocks
      : presetSelection !== null
        ? presetSelection.blocks
        : defaultBlockIds(library, scope));
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

export interface ResolveVariablesSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  blocks: readonly string[];
  prompting: boolean;
  givenVariables: Readonly<Record<string, string>>;
  previous: Manifest | null;
}

export async function resolveVariablesSelection({
  ctx,
  library,
  scope,
  blocks,
  prompting,
  givenVariables,
  previous,
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
      ...givenVariables,
    },
    { home: ctx.paths.home, searchPath: ctx.searchPath },
  );
  const variables = prompting ? await promptVariables(needed, known) : known;
  const missing = needed.filter((name) => !variables[name]?.trim());
  if (missing.length > 0) {
    throw new UsageError(
      `Missing variables: ${missing.map((name) => `--var ${name}=<value>`).join(' ')}`,
    );
  }
  return variables;
}

export interface ResolveSkillsSelectionParams {
  ctx: Context;
  skillLibrary: SkillLibrary;
  scope: Scope;
  prompting: boolean;
  requestedSkills?: string[];
  requestedSkillMode?: SkillMode;
  requestedPreset?: PresetChoice;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition;
  previous: Manifest | null;
}

export async function resolveSkillsSelection({
  ctx,
  skillLibrary,
  scope,
  prompting,
  requestedSkills,
  requestedSkillMode,
  requestedPreset,
  presetSelection,
  replacedPreset,
  previous,
}: ResolveSkillsSelectionParams): Promise<{
  skills: string[];
  skillMode: SkillMode;
}> {
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
    requestedSkills ??
    (recordedSkills !== null
      ? requestedPreset !== undefined && presetSelection !== null
        ? applyReRunPresetSkills({
            recordedSkills,
            previousPresetSkills: replacedPreset?.skills ?? [],
            presetSkills: presetSelection.skills,
          })
        : recordedSkills
      : presetSelection !== null
        ? presetSelection.skills
        : defaultSkillNames(skillLibrary, scope));
  const skills = prompting
    ? await promptSkills(skillLibrary, scope, initialSkills)
    : initialSkills;
  const previousMode = previous?.options.skillMode ?? DEFAULT_SKILL_MODE;
  const firstParty = skills.some(
    (name) => findSkill(skillLibrary, name)?.origin.type === 'local',
  );
  const skillMode =
    scope === 'global'
      ? (requestedSkillMode ??
        (prompting && firstParty
          ? await promptSkillMode(previousMode)
          : previousMode))
      : DEFAULT_SKILL_MODE;
  return { skills, skillMode };
}

export interface ResolveMcpSelectionParams {
  ctx: Context;
  mcpCatalog: McpCatalog;
  scope: Scope;
  prompting: boolean;
  requestedMcp?: string[];
  location: Location;
  previous: Manifest | null;
}

export async function resolveMcpSelection({
  ctx,
  mcpCatalog,
  scope,
  prompting,
  requestedMcp,
  location,
  previous,
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
  const initialMcp =
    requestedMcp ??
    (recordedMcp !== null
      ? recordedMcp
      : scope === 'project'
        ? [
            ...new Set([
              ...defaultMcpServerNames(mcpCatalog, 'project'),
              ...detectedMcp,
            ]),
          ]
        : defaultMcpServerNames(mcpCatalog, scope));
  return prompting
    ? promptMcpServers({
        catalog: mcpCatalog,
        scope,
        initial: initialMcp,
      })
    : initialMcp;
}

export interface ResolveInstallOptionsParams {
  ctx: Context;
  scope: Scope;
  location: Location;
  prompting: boolean;
  requestedLinkCommand?: boolean;
  requestedKeepLocal?: boolean;
  previous: Manifest | null;
}

export async function resolveInstallOptions({
  ctx,
  scope,
  location,
  prompting,
  requestedLinkCommand,
  requestedKeepLocal,
  previous,
}: ResolveInstallOptionsParams): Promise<{
  linkCommand: boolean;
  keepLocal: boolean;
}> {
  const previousLink = previous?.options.linkCommand ?? false;
  const linkCommand =
    scope === 'global'
      ? (requestedLinkCommand ??
        (prompting
          ? await promptLinkCommand(previous ? previousLink : true, ctx.paths)
          : previousLink))
      : false;
  const git = location.project?.git;
  const previousLocal = previous?.options.keepLocal ?? false;
  if (requestedKeepLocal && !git) {
    throw new UsageError(
      `${location.project?.dir ?? ctx.cwd} is not in a git repository, so files cannot be kept local.`,
    );
  }
  if (
    location.project &&
    previousLocal &&
    !git &&
    requestedKeepLocal === undefined
  ) {
    notifyLeftGit({ ctx, prompting, projectDir: location.project.dir });
  }
  const keepLocal =
    scope === 'project' && git
      ? (requestedKeepLocal ??
        (prompting ? await promptKeepLocal(previousLocal) : previousLocal))
      : false;
  return { linkCommand, keepLocal };
}
