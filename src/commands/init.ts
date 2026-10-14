import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { ManifestError, UsageError } from '../errors.ts';
import { buildPlan } from '../install/plan.ts';
import type { McpCatalog } from '../mcp/model.ts';
import {
  findPreset,
  loadPresetsIfAvailable,
  type PresetChoice,
  type PresetDefinition,
  type ProjectStyle,
  type ResolvedPresetSelection,
  resolvePresetSelection,
  resolveProjectPresetChoice,
  resolveProjectStyle,
} from '../project/presets.ts';
import { promptProjectDir, promptScope } from '../prompts/selection.ts';
import { runWizard, wizardStep } from '../prompts/wizard.ts';
import { DEFAULT_SKILL_MODE, type SkillMode } from '../skills/install.ts';
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
  resolveMcpSelection,
  resolveSkillModeSelection,
  resolveSkillsSelection,
  resolveToolsSelection,
  resolveVariablesSelection,
} from './init-selection.ts';
import {
  confirmAndApply,
  fetchSkills,
  loadLibrary,
  loadMcpServers,
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
  mcp?: string[];
  skillMode?: SkillMode;
  preset?: PresetChoice;
  style?: ProjectStyle;
  variables: Record<string, string>;
  keepLocal?: boolean;
  yes: boolean;
  dryRun: boolean;
}

interface ScopeSpecificOptions {
  skillMode?: SkillMode | undefined;
  keepLocal?: boolean | undefined;
  preset?: PresetChoice | undefined;
  style?: ProjectStyle | undefined;
}

function checkScopeOptions(
  scope: Scope,
  { skillMode, keepLocal, preset, style }: ScopeSpecificOptions,
): void {
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

interface ResolvePresetDefaultsParams {
  ctx: Context;
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  presets: readonly PresetDefinition[];
  hasGlobalInstall: boolean;
  location: Location;
  previous: Manifest | null;
  reconciled: ReconciledManifest | null;
  preset: PresetChoice | undefined;
  style: ProjectStyle | undefined;
  requestedPreset: PresetChoice | undefined;
  requestedStyle: ProjectStyle | undefined;
}

interface ResolvedPresetDefaults {
  presetChanged: boolean;
  styleChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset: PresetDefinition | undefined;
}

function resolvePresetDefaults({
  library,
  skillLibrary,
  presets,
  hasGlobalInstall,
  location,
  previous,
  reconciled,
  preset,
  style,
  requestedPreset,
  requestedStyle,
}: ResolvePresetDefaultsParams): ResolvedPresetDefaults {
  const previousPreset = reconciled?.preset;
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
        packageManager: location.detection?.packageManager,
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

  return { presetChanged, styleChanged, presetSelection, replacedPreset };
}

/**
 * Sets up instructions, skills and MCP servers for a scope. In a terminal each
 * question is a wizard step: esc goes back to the previous question with its
 * answer kept, and esc on the first question cancels.
 */
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
    keepLocal: requestedKeepLocal,
    ...confirmOptions
  }: InitOptions,
): Promise<number> {
  const prompting = ctx.interactive && !confirmOptions.yes;
  let scope!: Scope;
  let projectDir: string | undefined;
  let location!: Location;
  let library!: BlockLibrary;
  let skillLibrary!: SkillLibrary;
  let mcpCatalog!: McpCatalog;
  let previous: Manifest | null = null;
  let reconciled: ReconciledManifest | null = null;
  let tools: ToolId[] = [];
  let presets: PresetDefinition[] = [];
  let hasGlobalInstall = false;
  let preset: PresetChoice | undefined;
  let style: ProjectStyle | undefined;
  let presetDefaults!: ResolvedPresetDefaults;
  let blocks: string[] = [];
  let variables: Record<string, string> = {};
  let skills: string[] = [];
  let skillMode: SkillMode = DEFAULT_SKILL_MODE;
  let mcp: string[] = [];
  let keepLocal = false;
  let code = 0;

  await runWizard([
    wizardStep<Scope>(async (remembered) => {
      const chosen =
        requestedScope ??
        (prompting ? await promptScope(remembered) : undefined);

      if (!chosen) throw new UsageError('Pass --global or --project <dir>.');

      checkScopeOptions(chosen, {
        skillMode: requestedSkillMode,
        keepLocal: requestedKeepLocal,
        preset: requestedPreset,
        style: requestedStyle,
      });
      scope = chosen;

      return scope;
    }),
    wizardStep<string | undefined>(async (remembered) => {
      projectDir =
        scope === 'project' && requestedProjectDir === undefined && prompting
          ? await promptProjectDir(ctx.cwd, remembered)
          : requestedProjectDir;

      return projectDir;
    }),
    wizardStep<undefined>(async () => {
      location = await resolveLocation({
        ctx,
        scope,
        projectDir,
        detect: scope === 'project',
      });
      library = await loadLibrary(ctx);
      skillLibrary = await loadSkillLibrary(ctx.repoRoot);
      mcpCatalog = await loadMcpServers(ctx);
      previous = await readLocationManifest({ ctx, prompting, location });
      reconciled = previous
        ? await reconcileManifest({
            manifest: previous,
            library,
            location,
            lookupEnv: { home: ctx.paths.home, searchPath: ctx.searchPath },
          })
        : null;

      return undefined;
    }),
    wizardStep<ToolId[]>(async (remembered) => {
      tools = await resolveToolsSelection({
        ctx,
        scope,
        prompting,
        requestedTools,
        previous,
        remembered,
      });

      return tools;
    }),
    wizardStep<PresetChoice | undefined>(async (remembered) => {
      if (scope !== 'project') {
        preset = undefined;

        return preset;
      }

      presets = await loadPresetsIfAvailable(ctx.repoRoot, {
        blockLibrary: library,
        skillLibrary,
      });
      const globalManifest = await readGlobalManifestForProject(ctx, prompting);
      hasGlobalInstall =
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

      preset = await resolveProjectPresetChoice({
        scope,
        prompting,
        presets,
        detection: location.detection,
        previous,
        previousPreset: reconciled?.preset,
        requestedPreset,
        remembered,
      });

      return preset;
    }),
    wizardStep<ProjectStyle | undefined>(async (remembered) => {
      style = await resolveProjectStyle({
        scope,
        prompting,
        hasGlobalInstall,
        detection: location.detection,
        previous,
        preset,
        requestedStyle,
        remembered,
      });

      return style;
    }),
    wizardStep<string[]>(async (remembered) => {
      presetDefaults =
        scope === 'project'
          ? resolvePresetDefaults({
              ctx,
              library,
              skillLibrary,
              presets,
              hasGlobalInstall,
              location,
              previous,
              reconciled,
              preset,
              style,
              requestedPreset,
              requestedStyle,
            })
          : {
              presetChanged: false,
              styleChanged: false,
              presetSelection: null,
              replacedPreset: undefined,
            };
      blocks = await resolveBlocksSelection({
        ctx,
        library,
        scope,
        prompting,
        requestedBlocks,
        preset,
        style,
        presetChanged: presetDefaults.presetChanged,
        styleChanged: presetDefaults.styleChanged,
        presetSelection: presetDefaults.presetSelection,
        replacedPreset: presetDefaults.replacedPreset,
        reconciled,
        remembered,
      });

      return blocks;
    }),
    wizardStep<Record<string, string>>(async (remembered) => {
      variables = await resolveVariablesSelection({
        ctx,
        library,
        scope,
        blocks,
        prompting,
        givenVariables,
        previous,
        reconciled,
        remembered,
      });

      return variables;
    }),
    wizardStep<string[]>(async (remembered) => {
      skills = await resolveSkillsSelection({
        ctx,
        library,
        skillLibrary,
        scope,
        blocks,
        prompting,
        requestedSkills,
        presetChanged: presetDefaults.presetChanged,
        presetSelection: presetDefaults.presetSelection,
        replacedPreset: presetDefaults.replacedPreset,
        previous,
        remembered,
      });

      return skills;
    }),
    wizardStep<SkillMode>(async (remembered) => {
      skillMode = await resolveSkillModeSelection({
        skillLibrary,
        scope,
        skills,
        prompting,
        requestedSkillMode,
        previous,
        remembered,
      });

      return skillMode;
    }),
    wizardStep<string[]>(async (remembered) => {
      mcp = await resolveMcpSelection({
        ctx,
        mcpCatalog,
        scope,
        prompting,
        requestedMcp,
        location,
        previous,
        remembered,
      });

      return mcp;
    }),
    wizardStep<boolean>(async (remembered) => {
      ({ keepLocal } = await resolveInstallOptions({
        ctx,
        scope,
        location,
        prompting,
        requestedKeepLocal,
        previous,
        reconciled,
        remembered,
      }));

      return keepLocal;
    }),
    wizardStep<number>(async () => {
      code = await planAndApply();

      return code;
    }),
  ]);

  return code;

  async function planAndApply(): Promise<number> {
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
        keepLocal,
        skillMode,
        preset,
        style,
      },
      library,
      paths: ctx.paths,
      repoRoot: ctx.repoRoot,
      previous,
      manifestPath: location.manifestPath,
      project: location.project,
      skillSources,
      mcpCatalog,
    });

    if (keepLocal) {
      await warnTrackedFiles({
        ctx,
        prompting,
        plan,
        project: location.project,
      });
    }

    const result = await confirmAndApply(ctx, plan, confirmOptions);

    return result.code;
  }
}
