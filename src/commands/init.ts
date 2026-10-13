import { resolve } from 'node:path';

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
import { displayPath } from '../install/describe.ts';
import { isDirectory } from '../install/fs.ts';
import { buildPlan } from '../install/plan.ts';
import {
  defaultMcpServerNames,
  detectedMcpServerNames,
  outOfScopeMcpServerNames,
  type SelectMcpServersParams,
  unknownMcpServerNames,
} from '../mcp/model.ts';
import type { ProjectDetection } from '../project/detect.ts';
import {
  findPreset,
  loadPresets,
  type PresetDefinition,
  type PresetId,
  type PresetLibraries,
  presetsPath,
  type ProjectStyle,
  resolvePresetSelection,
} from '../project/presets.ts';
import {
  promptBlocks,
  promptKeepLocal,
  promptLinkCommand,
  promptMcpServers,
  promptPreset,
  promptProjectDir,
  promptProjectStyle,
  promptScope,
  promptSkillMode,
  promptSkills,
  promptTools,
  promptVariables,
} from '../prompts/selection.ts';
import { DEFAULT_SKILL_MODE, type SkillMode } from '../skills/install.ts';
import {
  defaultSkillNames,
  findSkill,
  loadSkillLibrary,
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
  confirmAndApply,
  dropUnavailableBlocks,
  dropUnavailableMcpServers,
  dropUnknownPreset,
  dropUnknownSkills,
  fetchSkills,
  loadLibrary,
  loadMcpServers,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  warnLockedSkills,
  warnTrackedFiles,
} from './shared.ts';

export interface InitOptions {
  scope?: Scope;
  projectDir?: string;
  tools?: ToolId[];
  blocks?: string[];
  skills?: string[];
  mcp?: string[];
  skillMode?: SkillMode;
  preset?: PresetId;
  style?: ProjectStyle;
  variables: Record<string, string>;
  linkCommand?: boolean;
  keepLocal?: boolean;
  yes: boolean;
  dryRun: boolean;
}

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

function checkExplicitMcp({
  catalog,
  names,
  scope,
}: SelectMcpServersParams): void {
  const unknown = unknownMcpServerNames(catalog, names);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown MCP servers: ${unknown.join(', ')}`);
  }
  const outOfScope = outOfScopeMcpServerNames({ catalog, names, scope });
  if (outOfScope.length > 0) {
    throw new UsageError(
      `MCP servers not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
}

function isOnSearchPath(ctx: Context, dir: string): boolean {
  const wanted = resolve(dir);
  return ctx.searchPath.some((entry) => resolve(ctx.cwd, entry) === wanted);
}

interface ScopeSpecificOptions {
  linkCommand?: boolean | undefined;
  skillMode?: SkillMode | undefined;
  keepLocal?: boolean | undefined;
  preset?: PresetId | undefined;
  style?: ProjectStyle | undefined;
}

function checkScopeOptions(
  scope: Scope,
  { linkCommand, skillMode, keepLocal, preset, style }: ScopeSpecificOptions,
): void {
  if (scope === 'project' && linkCommand !== undefined) {
    throw new UsageError(
      '--link-command only applies to system-wide installs.',
    );
  }
  if (scope === 'project' && skillMode !== undefined) {
    throw new UsageError('--skill-mode only applies to system-wide installs.');
  }
  if (scope === 'global' && keepLocal !== undefined) {
    throw new UsageError('--local only applies to project installs.');
  }
  if (scope === 'global' && preset !== undefined) {
    throw new UsageError('--preset only applies to project installs.');
  }
  if (scope === 'global' && style !== undefined) {
    throw new UsageError('--style only applies to project installs.');
  }
}

async function loadPresetsIfAvailable(
  repoRoot: string,
  libraries: PresetLibraries,
): Promise<PresetDefinition[]> {
  const dir = presetsPath(repoRoot);
  if (!(await isDirectory(dir))) return [];
  return loadPresets(dir, libraries);
}

interface ResolveProjectPresetParams {
  scope: Scope;
  prompting: boolean;
  hasGlobalInstall: boolean;
  presets: readonly PresetDefinition[];
  detection: ProjectDetection | undefined;
  previous: Manifest | null;
  previousPreset: PresetId | undefined;
  requestedPreset: PresetId | undefined;
  requestedStyle: ProjectStyle | undefined;
}

async function resolveProjectPresetAndStyle({
  scope,
  prompting,
  hasGlobalInstall,
  presets,
  detection,
  previous,
  previousPreset,
  requestedPreset,
  requestedStyle,
}: ResolveProjectPresetParams): Promise<{
  preset: PresetId | undefined;
  style: ProjectStyle | undefined;
}> {
  if (scope !== 'project') {
    return { preset: undefined, style: undefined };
  }

  let preset: PresetId | undefined;
  if (requestedPreset !== undefined) {
    preset = requestedPreset;
  } else if (previous !== null) {
    preset = previousPreset;
  } else if (prompting && presets.length > 0) {
    preset = await promptPreset(presets, detection?.preset);
  } else if (presets.length > 0) {
    preset = detection?.preset;
  }

  const hasAdditive =
    (detection?.detectedBlocks.length ?? 0) > 0 ||
    (detection?.detectedSkills.length ?? 0) > 0;
  const defaultStyle: ProjectStyle = hasGlobalInstall
    ? 'lean'
    : 'self-contained';
  let style: ProjectStyle | undefined;
  if (requestedStyle !== undefined) {
    style = requestedStyle;
  } else if (previous !== null) {
    style = previous.options.style;
  } else if (prompting) {
    style = await promptProjectStyle(defaultStyle);
  } else if (preset !== undefined || hasAdditive) {
    style = defaultStyle;
  }

  return { preset, style };
}

interface ApplyReRunPresetAndStyleParams {
  library: BlockLibrary;
  recordedBlocks: readonly string[];
  presetBlocks: readonly string[];
  requestedStyle: ProjectStyle | undefined;
}

function applyReRunPresetAndStyle({
  library,
  recordedBlocks,
  presetBlocks,
  requestedStyle,
}: ApplyReRunPresetAndStyleParams): string[] {
  const projectDefaults = new Set(defaultBlockIds(library, 'project'));
  const wanted = new Set(recordedBlocks);
  if (requestedStyle === 'lean') {
    for (const id of projectDefaults) {
      wanted.delete(id);
    }
  } else if (requestedStyle === 'self-contained') {
    for (const id of projectDefaults) {
      wanted.add(id);
    }
  }
  for (const id of presetBlocks) {
    wanted.add(id);
  }
  return library.blocks
    .filter((block) => block.scopes.includes('project') && wanted.has(block.id))
    .map((block) => block.id);
}

export async function runInit(
  ctx: Context,
  {
    scope: requestedScope,
    projectDir: requestedProjectDir,
    tools: requestedTools,
    blocks: requestedBlocks,
    skills: requestedSkills,
    mcp: requestedMcp,
    skillMode: requestedSkillMode,
    preset: requestedPreset,
    style: requestedStyle,
    variables: givenVariables,
    linkCommand: requestedLinkCommand,
    keepLocal: requestedKeepLocal,
    ...confirmOptions
  }: InitOptions,
): Promise<number> {
  const prompting = ctx.interactive && !confirmOptions.yes;
  const scope = requestedScope ?? (prompting ? await promptScope() : undefined);
  if (!scope) throw new UsageError('Pass --global or --project <dir>.');
  checkScopeOptions(scope, {
    linkCommand: requestedLinkCommand,
    skillMode: requestedSkillMode,
    keepLocal: requestedKeepLocal,
    preset: requestedPreset,
    style: requestedStyle,
  });

  const projectDir =
    scope === 'project' && requestedProjectDir === undefined && prompting
      ? await promptProjectDir(ctx.cwd)
      : requestedProjectDir;
  const location = await resolveLocation({
    ctx,
    scope,
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const mcpCatalog = await loadMcpServers(ctx);
  const previous = await readLocationManifest(ctx, prompting, location);

  const initialTools =
    requestedTools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  const tools = prompting
    ? await promptTools(scope, initialTools, ctx.paths)
    : initialTools;
  if (!prompting && tools.length === 0 && !previous) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  const presets =
    scope === 'project'
      ? await loadPresetsIfAvailable(ctx.repoRoot, {
          blockLibrary: library,
          skillLibrary,
        })
      : [];
  const globalManifest =
    scope === 'project'
      ? await readGlobalManifest(globalManifestPath(ctx.paths)).catch(
          () => null,
        )
      : null;
  const hasGlobalInstall =
    scope === 'project' &&
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
    scope === 'project' &&
    (requestedPreset !== undefined ||
      requestedStyle !== undefined ||
      (previous === null &&
        (preset !== undefined ||
          style !== undefined ||
          (location.detection?.detectedBlocks.length ?? 0) > 0 ||
          (location.detection?.detectedSkills.length ?? 0) > 0)));
  const presetSelection = usePresetDefaults
    ? resolvePresetSelection({
        preset: preset ? findPreset(presets, preset) : undefined,
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
  const initialBlocks =
    requestedBlocks ??
    (recordedBlocks !== null
      ? presetSelection !== null
        ? applyReRunPresetAndStyle({
            library,
            recordedBlocks,
            presetBlocks:
              requestedPreset !== undefined ? presetSelection.blocks : [],
            requestedStyle,
          })
        : recordedBlocks
      : presetSelection !== null
        ? presetSelection.blocks
        : defaultBlockIds(library, scope));
  const chosen = prompting
    ? await promptBlocks(library, scope, initialBlocks)
    : initialBlocks;
  const { ids: blocks, added } = withRequirements(library, chosen);
  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }

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
  const known = await lookupVariables(needed, {
    ...previous?.variables,
    ...givenVariables,
  });
  const variables = prompting ? await promptVariables(needed, known) : known;
  const missing = needed.filter((name) => !variables[name]?.trim());
  if (missing.length > 0) {
    throw new UsageError(
      `Missing variables: ${missing.map((name) => `--var ${name}=<value>`).join(' ')}`,
    );
  }

  if (requestedSkills) {
    checkExplicitSkills(skillLibrary, requestedSkills, scope);
  }
  const recordedSkills = previous
    ? dropUnknownSkills({
        ctx,
        prompting,
        library: skillLibrary,
        names: previous.skills,
      })
    : null;
  const initialSkills =
    requestedSkills ??
    (recordedSkills !== null
      ? requestedPreset !== undefined && presetSelection !== null
        ? [...new Set([...recordedSkills, ...presetSelection.skills])]
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
  const mcp = prompting
    ? await promptMcpServers({
        catalog: mcpCatalog,
        scope,
        initial: initialMcp,
      })
    : initialMcp;

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
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  const keepLocal =
    scope === 'project' && git
      ? (requestedKeepLocal ??
        (prompting ? await promptKeepLocal(previousLocal) : previousLocal))
      : false;

  const installing = tools.length > 0 ? skills : [];
  if (scope === 'global') await warnLockedSkills(ctx, prompting, installing);
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: installing,
  });
  const plan = await buildPlan({
    scope,
    selection: {
      tools,
      blocks,
      skills,
      mcp,
      variables,
      linkCommand,
      keepLocal,
      skillMode,
      ...(preset !== undefined ? { preset } : {}),
      ...(style !== undefined ? { style } : {}),
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
    skillSources,
    mcpCatalog,
  });
  if (keepLocal) {
    await warnTrackedFiles({
      ctx,
      prompting,
      plan,
      ...(location.project ? { project: location.project } : {}),
    });
  }

  const result = await confirmAndApply(ctx, plan, confirmOptions);
  if (
    result.applied &&
    linkCommand &&
    !isOnSearchPath(ctx, ctx.paths.localBin)
  ) {
    notify({
      ctx,
      prompting,
      message: `${displayPath({ path: ctx.paths.localBin, home: ctx.paths.home })} is not on your PATH; add it to run agents-config from any directory.`,
      level: 'warn',
    });
  }
  return result.code;
}
