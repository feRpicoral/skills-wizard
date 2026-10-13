import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import * as clack from '@clack/prompts';

import {
  outOfScopeBlockIds,
  requiredVariables,
  selectBlocks,
  unknownBlockIds,
} from '../blocks/compose.ts';
import {
  type BlockLibrary,
  loadBlockLibrary,
  type Scope,
} from '../blocks/library.ts';
import { lookupVariables } from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import {
  AgentsConfigError,
  isSystemError,
  MissingVariablesError,
  UsageError,
} from '../errors.ts';
import { applyPlan } from '../install/apply.ts';
import {
  conflicts,
  describePlan,
  displayPath,
  hasChanges,
  planPath,
} from '../install/describe.ts';
import { isDirectory, lstatIfExists } from '../install/fs.ts';
import type { Plan, ProjectContext } from '../install/plan.ts';
import { mcpConfigPaths, skillFolders } from '../install/targets.ts';
import {
  loadMcpCatalog,
  type McpCatalog,
  mcpCatalogPath,
  outOfScopeMcpServerNames,
  unknownMcpServerNames,
} from '../mcp/model.ts';
import { detectProject, type ProjectDetection } from '../project/detect.ts';
import { isPresetId, type PresetId } from '../project/presets.ts';
import { buildProjectSeed } from '../project/seed.ts';
import { confirmApply, promptVariables } from '../prompts/selection.ts';
import { resolveSkillSources, type SkillSource } from '../skills/install.ts';
import { type SkillLibrary, unknownSkillNames } from '../skills/library.ts';
import { readSkillLock, skillLockPath } from '../skills/lock.ts';
import type { SourceCache } from '../skills/sources.ts';
import {
  checkMcpEntries,
  checkSkillEntries,
  globalManifestPath,
  type Manifest,
  projectManifestPath,
  readGlobalManifest,
  readProjectManifest,
} from '../state/manifest.ts';
import { forgetProject, recordProject } from '../state/projects.ts';

const run = promisify(execFile);

export interface Location {
  scope: Scope;
  manifestPath: string;
  project?: ProjectContext;
  detection?: ProjectDetection;
}

interface NotifyParams {
  ctx: Context;
  prompting: boolean;
  message: string;
  level?: 'info' | 'warn';
}

export function notify({
  ctx,
  prompting,
  message,
  level = 'info',
}: NotifyParams): void {
  if (!prompting) {
    ctx.print(message);
  } else if (level === 'warn') {
    clack.log.warn(message);
  } else {
    clack.log.info(message);
  }
}

export async function loadLibrary(ctx: Context): Promise<BlockLibrary> {
  return loadBlockLibrary(join(ctx.repoRoot, 'blocks'));
}

export async function loadMcpServers(ctx: Context): Promise<McpCatalog> {
  const file = mcpCatalogPath(ctx.repoRoot);
  if (!(await lstatIfExists(file))) return { servers: [] };
  return loadMcpCatalog(file);
}

async function git(projectDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: projectDir });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitContext(projectDir: string): Promise<ProjectContext['git']> {
  const root = await git(projectDir, ['rev-parse', '--show-toplevel']);
  const excludePath = await git(projectDir, [
    'rev-parse',
    '--git-path',
    'info/exclude',
  ]);
  if (!root || !excludePath) return undefined;
  return { root, excludePath: resolve(projectDir, excludePath) };
}

interface ResolveLocationParams {
  ctx: Context;
  scope: Scope;
  projectDir?: string;
}

export async function resolveLocation({
  ctx,
  scope,
  projectDir,
}: ResolveLocationParams): Promise<Location> {
  if (scope === 'global') {
    return { scope, manifestPath: globalManifestPath(ctx.paths) };
  }

  const requested = resolve(ctx.cwd, projectDir ?? '.');
  if (!(await isDirectory(requested))) {
    throw new UsageError(`${requested} is not a directory`);
  }
  const dir = await realpath(requested);
  const repository = await gitContext(dir);
  const detection = await detectProject(dir);
  return {
    scope,
    manifestPath: projectManifestPath(dir),
    detection,
    project: {
      dir,
      title: detection.name,
      seed: buildProjectSeed(detection),
      ...(repository ? { git: repository } : {}),
    },
  };
}

export async function readLocationManifest(
  ctx: Context,
  prompting: boolean,
  location: Location,
): Promise<Manifest | null> {
  const manifest = await readRecordedManifest(ctx, prompting, location);
  const folders = manifest
    ? skillFolders({
        scope: location.scope,
        paths: ctx.paths,
        ...(location.project ? { project: location.project } : {}),
      })
    : null;
  const mcpPaths = manifest
    ? mcpConfigPaths({
        scope: location.scope,
        paths: ctx.paths,
        ...(location.project ? { project: location.project } : {}),
      })
    : null;
  if (manifest && folders) {
    checkSkillEntries({
      file: location.manifestPath,
      entries: manifest.entries,
      folders,
      scope: location.scope,
    });
  }
  if (manifest && mcpPaths) {
    checkMcpEntries({
      file: location.manifestPath,
      entries: manifest.entries,
      mcpPaths,
    });
  }
  return manifest;
}

async function readRecordedManifest(
  ctx: Context,
  prompting: boolean,
  { manifestPath, project }: Location,
): Promise<Manifest | null> {
  if (!project) return readGlobalManifest(manifestPath);

  const result = await readProjectManifest(manifestPath, {
    dir: project.dir,
    ...(project.git ? { gitExcludePath: project.git.excludePath } : {}),
  });
  for (const path of result?.ignored ?? []) {
    notify({
      ctx,
      prompting,
      message: project.git
        ? `The recorded git exclude entries (${path}) belong to another repository, so they were ignored and left untouched.`
        : `The recorded git exclude entries (${path}) were left untouched because the project is no longer in a git repository.`,
      level: 'warn',
    });
  }
  return result?.manifest ?? null;
}

interface SetVariablesCommandParams {
  ctx: Context;
  location: Location;
  names: readonly string[];
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

// A leading ~ stays unquoted so the shell still expands it.
function shellPath(path: string): string {
  if (path === '~') return path;
  return path.startsWith('~/')
    ? `~/${shellQuote(path.slice(2))}`
    : shellQuote(path);
}

export function setVariablesCommand({
  ctx,
  location,
  names,
}: SetVariablesCommandParams): string {
  const target = location.project
    ? `--project ${shellPath(displayPath({ path: location.project.dir, home: ctx.paths.home }))}`
    : '--global';
  const variables = names.map((name) => `--var ${name}=<value>`).join(' ');
  return `agents-config init ${target} ${variables}`;
}

interface ResolveVariablesParams {
  ctx: Context;
  prompting: boolean;
  library: BlockLibrary;
  blocks: readonly string[];
  location: Location;
  recorded: Readonly<Record<string, string>>;
}

// A block edited to use a new variable has no recorded value yet. Look it up
// (or ask for it) the way init does, and stop with the init command otherwise.
export async function resolveVariables({
  ctx,
  prompting,
  library,
  blocks,
  location,
  recorded,
}: ResolveVariablesParams): Promise<Record<string, string>> {
  const needed = requiredVariables(
    selectBlocks(library, blocks, location.scope),
  );
  const missing = needed.filter((name) => !recorded[name]?.trim());
  if (missing.length === 0) return { ...recorded };

  const found = await lookupVariables(missing, recorded);
  if (prompting) {
    return { ...recorded, ...(await promptVariables(missing, found)) };
  }
  const unresolved = missing.filter((name) => !found[name]?.trim());
  if (unresolved.length > 0) {
    throw new MissingVariablesError(
      `The blocks now use variables with no recorded value: ${unresolved.join(', ')}. Set them with ${setVariablesCommand({ ctx, location, names: unresolved })}`,
    );
  }
  ctx.print(
    `Using looked-up values for new variables: ${missing.map((name) => `${name}=${found[name] ?? ''}`).join(', ')}`,
  );
  return found;
}

export function notifyLeftGit(
  ctx: Context,
  prompting: boolean,
  projectDir: string,
): void {
  notify({
    ctx,
    prompting,
    message: `${displayPath({ path: projectDir, home: ctx.paths.home })} is no longer in a git repository, so its files are no longer kept local.`,
    level: 'warn',
  });
}

const BLOCK_REPLACEMENT_SKILLS: Readonly<Record<string, string>> = {
  'git/github-repo-setup': 'github-repo-setup',
  'stack/supabase-prisma': 'supabase-prisma',
};

export function replacementSkillHint(ids: readonly string[]): string {
  const skills = [
    ...new Set(
      ids
        .map((id) => BLOCK_REPLACEMENT_SKILLS[id])
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (skills.length === 0) return '';
  return ` (use the ${skills.join(', ')} skill${skills.length === 1 ? '' : 's'} instead)`;
}

interface DropUnknownPresetParams {
  ctx: Context;
  prompting: boolean;
  preset: string | undefined;
}

export function dropUnknownPreset({
  ctx,
  prompting,
  preset,
}: DropUnknownPresetParams): PresetId | undefined {
  if (preset === undefined) return undefined;
  if (isPresetId(preset)) return preset;
  notify({
    ctx,
    prompting,
    message: `Preset "${preset}" is no longer recognized and was dropped.`,
    level: 'warn',
  });
  return undefined;
}

interface DropUnavailableBlocksParams {
  ctx: Context;
  prompting: boolean;
  library: BlockLibrary;
  ids: readonly string[];
  scope: Scope;
}

export function dropUnavailableBlocks({
  ctx,
  prompting,
  library,
  ids,
  scope,
}: DropUnavailableBlocksParams): string[] {
  const unknown = unknownBlockIds(library, ids);
  const outOfScope = outOfScopeBlockIds(library, ids, scope);
  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer in the library were dropped: ${unknown.join(', ')}${replacementSkillHint(unknown)}`,
      level: 'warn',
    });
  }
  if (outOfScope.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}${replacementSkillHint(outOfScope)}`,
      level: 'warn',
    });
  }
  return ids.filter((id) => !unknown.includes(id) && !outOfScope.includes(id));
}

interface DropUnknownSkillsParams {
  ctx: Context;
  prompting: boolean;
  library: SkillLibrary;
  names: readonly string[];
}

export function dropUnknownSkills({
  ctx,
  prompting,
  library,
  names,
}: DropUnknownSkillsParams): string[] {
  const unknown = unknownSkillNames(library, names);
  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Skills no longer in catalog.yaml or skills/ were dropped: ${unknown.join(', ')}`,
      level: 'warn',
    });
  }
  return names.filter((name) => !unknown.includes(name));
}

interface DropUnavailableMcpServersParams {
  ctx: Context;
  prompting: boolean;
  catalog: McpCatalog;
  names: readonly string[];
  scope: Scope;
}

export function dropUnavailableMcpServers({
  ctx,
  prompting,
  catalog,
  names,
  scope,
}: DropUnavailableMcpServersParams): string[] {
  const unknown = unknownMcpServerNames(catalog, names);
  const outOfScope = outOfScopeMcpServerNames({ catalog, names, scope });
  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `MCP servers no longer in mcp/servers.yaml were dropped: ${unknown.join(', ')}`,
      level: 'warn',
    });
  }
  if (outOfScope.length > 0) {
    notify({
      ctx,
      prompting,
      message: `MCP servers no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}`,
      level: 'warn',
    });
  }
  return names.filter(
    (name) => !unknown.includes(name) && !outOfScope.includes(name),
  );
}

export function sourceCache(ctx: Context): SourceCache {
  return { root: ctx.paths.sourcesDir, ...ctx.sources };
}

interface FetchSkillsParams {
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

interface WarnTrackedFilesParams {
  ctx: Context;
  prompting: boolean;
  plan: Plan;
  project?: ProjectContext;
}

export async function warnTrackedFiles({
  ctx,
  prompting,
  plan,
  project,
}: WarnTrackedFilesParams): Promise<void> {
  if (!project?.git) return;
  const root = project.git.root;
  const candidates = plan.actions
    .filter((action) => action.path.startsWith(project.dir))
    .map((action) => relative(root, action.path));
  if (candidates.length === 0) return;

  const tracked = await git(root, ['ls-files', '--', ...candidates]);
  if (tracked) {
    notify({
      ctx,
      prompting,
      message: `Already tracked by git, so keeping them local has no effect: ${tracked.split('\n').join(', ')}`,
      level: 'warn',
    });
  }
}

export interface ConfirmOptions {
  yes: boolean;
  dryRun: boolean;
  beforeApply?: () => Promise<void>;
}

async function trackProject(
  ctx: Context,
  prompting: boolean,
  plan: Plan,
): Promise<void> {
  if (plan.projectDir === undefined) return;
  try {
    if (await lstatIfExists(plan.manifestPath)) {
      await recordProject(ctx.paths, plan.projectDir);
    } else {
      await forgetProject(ctx.paths, plan.projectDir);
    }
  } catch (error) {
    if (!(error instanceof AgentsConfigError) && !isSystemError(error)) {
      throw error;
    }
    notify({
      ctx,
      prompting,
      message: `Could not update the list of recorded projects: ${error.message}`,
      level: 'warn',
    });
  }
}

export async function confirmAndApply(
  ctx: Context,
  plan: Plan,
  { yes, dryRun, beforeApply }: ConfirmOptions,
): Promise<{ code: number; applied: boolean }> {
  const prompting = ctx.interactive && !yes;
  const lines = describePlan(plan, ctx.paths.home);
  if (prompting) {
    clack.note(lines.join('\n') || 'Nothing to do', 'Plan');
  } else {
    lines.forEach((entry) => ctx.print(entry));
  }
  for (const warning of plan.warnings ?? []) {
    notify({ ctx, prompting, message: warning, level: 'warn' });
  }

  if (dryRun) {
    notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
    return { code: 0, applied: false };
  }
  const blocked = conflicts(plan);
  if (!hasChanges(plan) && blocked.length === 0) {
    notify({ ctx, prompting, message: 'Everything is up to date.' });
    return { code: 0, applied: false };
  }
  if (!ctx.interactive && !yes) {
    ctx.print(
      'Re-run with --yes to apply these changes, or --dry-run to preview them.',
    );
    return { code: 1, applied: false };
  }
  if (prompting && !(await confirmApply())) {
    notify({ ctx, prompting: true, message: 'Nothing was written.' });
    return { code: 1, applied: false };
  }

  await beforeApply?.();
  const outcome = await applyPlan(plan);
  await trackProject(ctx, prompting, plan);
  const changed = outcome.applied.filter(
    (action) => action.change.type !== 'none',
  ).length;
  const summary =
    changed === 0 && plan.manifestStatus !== 'unchanged'
      ? 'Updated the manifest.'
      : `Applied ${changed} change${changed === 1 ? '' : 's'}.`;
  if (prompting) clack.outro(summary);
  else ctx.print(summary);

  for (const action of outcome.skipped) {
    notify({
      ctx,
      prompting,
      message: `Skipped ${planPath({ plan, path: action.path, home: ctx.paths.home })}: ${action.reason ?? 'conflict'}`,
      level: 'warn',
    });
  }
  for (const failure of outcome.setupFailures) {
    notify({
      ctx,
      prompting,
      message: `Setup in ${planPath({ plan, path: failure.path, home: ctx.paths.home })} did not finish: ${failure.message}`,
      level: 'warn',
    });
  }
  const failed = outcome.skipped.length + outcome.setupFailures.length;
  return { code: failed > 0 ? 1 : 0, applied: true };
}
