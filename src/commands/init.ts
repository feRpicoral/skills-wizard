import { resolve } from 'node:path';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import { promptProjectDir, promptScope } from '../prompts/selection.ts';
import type { SkillMode } from '../skills/install.ts';
import { loadSkillLibrary } from '../skills/library.ts';
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
  notify,
  readLocationManifest,
  reconcileManifest,
  resolveLocation,
  warnLockedSkills,
  warnTrackedFiles,
} from './shared.ts';

interface InitOptions {
  scope?: Scope;
  projectDir?: string;
  tools?: ToolId[];
  blocks?: string[];
  skills?: string[];
  skillMode?: SkillMode;
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
}

function checkScopeOptions(
  scope: Scope,
  { linkCommand, skillMode, keepLocal }: ScopeSpecificOptions,
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
  const blocks = await resolveBlocksSelection({
    ctx,
    library,
    scope,
    prompting,
    ...(requestedBlocks ? { requestedBlocks } : {}),
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
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const { skills, skillMode } = await resolveSkillsSelection({
    ctx,
    skillLibrary,
    scope,
    prompting,
    ...(requestedSkills ? { requestedSkills } : {}),
    ...(requestedSkillMode ? { requestedSkillMode } : {}),
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
