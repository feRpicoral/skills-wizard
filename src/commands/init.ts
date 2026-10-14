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
import { buildPlan } from '../install/plan.ts';
import {
  promptBlocks,
  promptKeepLocal,
  promptLinkCommand,
  promptProjectDir,
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
import type { Manifest } from '../state/manifest.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  confirmAndApply,
  dropUnavailableBlocks,
  dropUnknownSkills,
  fetchSkills,
  loadLibrary,
  type Location,
  notify,
  notifyLeftGit,
  readLocationManifest,
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

interface ResolveToolsSelectionParams {
  ctx: Context;
  scope: Scope;
  prompting: boolean;
  requestedTools?: ToolId[];
  previous: Manifest | null;
}

async function resolveToolsSelection({
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

interface ResolveBlocksSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  prompting: boolean;
  requestedBlocks?: string[];
  previous: Manifest | null;
}

async function resolveBlocksSelection({
  ctx,
  library,
  scope,
  prompting,
  requestedBlocks,
  previous,
}: ResolveBlocksSelectionParams): Promise<string[]> {
  if (requestedBlocks) checkExplicitBlocks(library, requestedBlocks, scope);
  const initial =
    requestedBlocks ??
    (previous
      ? dropUnavailableBlocks({
          ctx,
          prompting,
          library,
          ids: previous.blocks,
          scope,
        })
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

interface ResolveVariablesSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  blocks: readonly string[];
  prompting: boolean;
  givenVariables: Readonly<Record<string, string>>;
  previous: Manifest | null;
}

async function resolveVariablesSelection({
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

interface ResolveSkillsSelectionParams {
  ctx: Context;
  skillLibrary: SkillLibrary;
  scope: Scope;
  prompting: boolean;
  requestedSkills?: string[];
  requestedSkillMode?: SkillMode;
  previous: Manifest | null;
}

async function resolveSkillsSelection({
  ctx,
  skillLibrary,
  scope,
  prompting,
  requestedSkills,
  requestedSkillMode,
  previous,
}: ResolveSkillsSelectionParams): Promise<{
  skills: string[];
  skillMode: SkillMode;
}> {
  if (requestedSkills) {
    checkExplicitSkills(skillLibrary, requestedSkills, scope);
  }
  const initialSkills =
    requestedSkills ??
    (previous
      ? dropUnknownSkills({
          ctx,
          prompting,
          library: skillLibrary,
          names: previous.skills,
        })
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

interface ResolveInstallOptionsParams {
  ctx: Context;
  scope: Scope;
  location: Location;
  prompting: boolean;
  requestedLinkCommand?: boolean;
  requestedKeepLocal?: boolean;
  previous: Manifest | null;
}

async function resolveInstallOptions({
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
