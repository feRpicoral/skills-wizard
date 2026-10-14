import { resolve } from 'node:path';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import type { PresetChoice, ProjectStyle } from '../project/presets.ts';
import { promptProjectDir, promptScope } from '../prompts/selection.ts';
import type { SkillMode } from '../skills/install.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  resolveBlocksSelection,
  resolveInstallOptions,
  resolveMcpSelection,
  resolveProjectPresetContext,
  resolveSkillsSelection,
  resolveToolsSelection,
  resolveVariablesSelection,
} from './init-selection.ts';
import {
  confirmAndApply,
  fetchSkills,
  loadLibrary,
  loadMcpServers,
  notify,
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
    detect: scope === 'project',
  });
  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const mcpCatalog = await loadMcpServers(ctx);
  const previous = await readLocationManifest({ ctx, prompting, location });

  const tools = await resolveToolsSelection({
    ctx,
    scope,
    prompting,
    ...(requestedTools ? { requestedTools } : {}),
    previous,
  });
  const { preset, style, presetSelection, replacedPreset } =
    await resolveProjectPresetContext({
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
    });
  const blocks = await resolveBlocksSelection({
    ctx,
    library,
    scope,
    prompting,
    ...(requestedBlocks ? { requestedBlocks } : {}),
    ...(requestedPreset !== undefined ? { requestedPreset } : {}),
    ...(requestedStyle !== undefined ? { requestedStyle } : {}),
    presetSelection,
    ...(replacedPreset ? { replacedPreset } : {}),
    previous,
  });
  const variables = await resolveVariablesSelection({
    ctx,
    library,
    scope,
    blocks,
    prompting,
    givenVariables,
    previous,
  });
  const { skills, skillMode } = await resolveSkillsSelection({
    ctx,
    skillLibrary,
    scope,
    prompting,
    ...(requestedSkills ? { requestedSkills } : {}),
    ...(requestedSkillMode ? { requestedSkillMode } : {}),
    ...(requestedPreset !== undefined ? { requestedPreset } : {}),
    presetSelection,
    ...(replacedPreset ? { replacedPreset } : {}),
    previous,
  });
  const mcp = await resolveMcpSelection({
    ctx,
    mcpCatalog,
    scope,
    prompting,
    ...(requestedMcp ? { requestedMcp } : {}),
    location,
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
