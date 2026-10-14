import { resolve } from 'node:path';

import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { ManifestError, UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import {
  findPreset,
  loadPresetsIfAvailable,
  type PresetChoice,
  type PresetDefinition,
  type ProjectStyle,
  type ResolvedPresetSelection,
  resolvePresetSelection,
  resolveProjectPresetAndStyle,
} from '../project/presets.ts';
import { promptProjectDir, promptScope } from '../prompts/selection.ts';
import type { SkillMode } from '../skills/install.ts';
import { loadSkillLibrary, type SkillLibrary } from '../skills/library.ts';
import {
  globalManifestPath,
  type Manifest,
  readGlobalManifest,
} from '../state/manifest.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  resolveBlocksSelection,
  resolveInstallOptions,
  resolveSkillsSelection,
  resolveToolsSelection,
  resolveVariablesSelection,
} from './init-selection.ts';
import {
  confirmAndApply,
  fetchSkills,
  loadLibrary,
  type Location,
  notify,
  readLocationManifest,
  type ReconciledManifest,
  reconcileManifest,
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
  skillMode?: SkillMode;
  preset?: PresetChoice;
  style?: ProjectStyle;
  variables: Record<string, string>;
  linkCommand?: boolean;
  keepLocal?: boolean;
  yes: boolean;
  dryRun: boolean;
}

function isOnSearchPath(ctx: Context, dir: string): boolean {
  const wanted = resolve(dir);
  return ctx.searchPath.some((entry) => resolve(ctx.cwd, entry) === wanted);
}

interface ScopeSpecificOptions {
  linkCommand?: boolean | undefined;
  skillMode?: SkillMode | undefined;
  keepLocal?: boolean | undefined;
  preset?: PresetChoice | undefined;
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

interface ResolveProjectPresetContextParams {
  ctx: Context;
  scope: Scope;
  prompting: boolean;
  tools: readonly ToolId[];
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  location: Location;
  previous: Manifest | null;
  reconciled: ReconciledManifest | null;
  requestedPreset: PresetChoice | undefined;
  requestedStyle: ProjectStyle | undefined;
}

interface ResolvedProjectPresetContext {
  preset: PresetChoice | undefined;
  style: ProjectStyle | undefined;
  presetChanged: boolean;
  styleChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset: PresetDefinition | undefined;
}

async function resolveProjectPresetContext({
  ctx,
  scope,
  prompting,
  tools,
  library,
  skillLibrary,
  location,
  previous,
  reconciled,
  requestedPreset,
  requestedStyle,
}: ResolveProjectPresetContextParams): Promise<ResolvedProjectPresetContext> {
  if (scope !== 'project') {
    return {
      preset: undefined,
      style: undefined,
      presetChanged: false,
      styleChanged: false,
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
  if (reconciled?.unknownPreset !== undefined) {
    notify({
      ctx,
      prompting,
      message: `Preset "${reconciled.unknownPreset}" is no longer recognized and was dropped.`,
      level: 'warn',
    });
  }
  const previousPreset = reconciled?.preset;
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

  const presetChanged =
    requestedPreset !== undefined ||
    (previous !== null &&
      preset !== undefined &&
      preset !== (previousPreset ?? 'none'));
  const styleChanged =
    requestedStyle !== undefined ||
    (previous !== null &&
      style !== undefined &&
      style !== previous.options.style);
  const usePresetDefaults =
    presetChanged ||
    styleChanged ||
    (previous === null &&
      ((preset !== undefined && preset !== 'none') ||
        style !== undefined ||
        (preset !== 'none' &&
          ((location.detection?.detectedBlocks.length ?? 0) > 0 ||
            (location.detection?.detectedSkills.length ?? 0) > 0))));
  const presetSelection = usePresetDefaults
    ? resolvePresetSelection({
        preset: findPreset(presets, preset),
        style: style ?? (hasGlobalInstall ? 'lean' : 'self-contained'),
        blockLibrary: library,
        skillLibrary,
        ...(location.detection?.packageManager !== undefined
          ? { packageManager: location.detection.packageManager }
          : {}),
        detectedBlocks:
          preset === 'none' ? [] : (location.detection?.detectedBlocks ?? []),
        detectedSkills:
          preset === 'none' ? [] : (location.detection?.detectedSkills ?? []),
      })
    : null;
  const replacedPreset =
    previous !== null &&
    presetChanged &&
    previousPreset !== undefined &&
    previousPreset !== preset
      ? findPreset(presets, previousPreset)
      : undefined;

  return {
    preset,
    style,
    presetChanged,
    styleChanged,
    presetSelection,
    replacedPreset,
  };
}

export async function runInit(
  ctx: Context,
  {
    scope: requestedScope,
    projectDir: requestedProjectDir,
    tools: requestedTools,
    blocks: requestedBlocks,
    skills: requestedSkills,
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
    detect: scope === 'project',
  });
  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const previous = await readLocationManifest({ ctx, prompting, location });
  const reconciled = previous
    ? await reconcileManifest({
        manifest: previous,
        library,
        location,
        lookupEnv: { home: ctx.paths.home, searchPath: ctx.searchPath },
      })
    : null;

  const tools = await resolveToolsSelection({
    ctx,
    scope,
    prompting,
    ...(requestedTools ? { requestedTools } : {}),
    previous,
  });
  const {
    preset,
    style,
    presetChanged,
    styleChanged,
    presetSelection,
    replacedPreset,
  } = await resolveProjectPresetContext({
    ctx,
    scope,
    prompting,
    tools,
    library,
    skillLibrary,
    location,
    previous,
    reconciled,
    requestedPreset,
    requestedStyle,
  });
  const blocks = await resolveBlocksSelection({
    ctx,
    library,
    scope,
    prompting,
    ...(requestedBlocks ? { requestedBlocks } : {}),
    ...(preset !== undefined ? { preset } : {}),
    ...(style !== undefined ? { style } : {}),
    presetChanged,
    styleChanged,
    presetSelection,
    ...(replacedPreset ? { replacedPreset } : {}),
    reconciled,
  });
  const variables = await resolveVariablesSelection({
    ctx,
    library,
    scope,
    blocks,
    prompting,
    givenVariables,
    previous,
    reconciled,
  });
  const { skills, skillMode } = await resolveSkillsSelection({
    ctx,
    skillLibrary,
    scope,
    prompting,
    ...(requestedSkills ? { requestedSkills } : {}),
    ...(requestedSkillMode ? { requestedSkillMode } : {}),
    presetChanged,
    presetSelection,
    ...(replacedPreset ? { replacedPreset } : {}),
    previous,
  });
  const { linkCommand, keepLocal } = await resolveInstallOptions({
    ctx,
    scope,
    location,
    prompting,
    ...(requestedLinkCommand !== undefined ? { requestedLinkCommand } : {}),
    ...(requestedKeepLocal !== undefined ? { requestedKeepLocal } : {}),
    previous,
    reconciled,
  });

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
