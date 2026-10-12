import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import * as clack from '@clack/prompts';

import {
  type BlockLibrary,
  loadBlockLibrary,
  type Scope,
} from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { applyPlan } from '../install/apply.ts';
import {
  conflicts,
  describePlan,
  hasChanges,
  planPath,
} from '../install/describe.ts';
import { isDirectory, readTextIfExists } from '../install/fs.ts';
import type { Plan, ProjectContext } from '../install/plan.ts';
import { confirmApply } from '../prompts/selection.ts';
import {
  globalManifestPath,
  type Manifest,
  projectManifestPath,
  readManifest,
  readProjectManifest,
} from '../state/manifest.ts';

const run = promisify(execFile);

interface Location {
  scope: Scope;
  manifestPath: string;
  project?: ProjectContext;
}

export function notify(
  ctx: Context,
  prompting: boolean,
  message: string,
  level: 'info' | 'warn' = 'info',
): void {
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

async function projectTitle(projectDir: string): Promise<string> {
  const packageJson = await readTextIfExists(join(projectDir, 'package.json'));
  if (packageJson === null) return basename(projectDir);
  try {
    const { name } = JSON.parse(packageJson) as { name?: unknown };
    return typeof name === 'string' && name.trim()
      ? name.trim()
      : basename(projectDir);
  } catch {
    return basename(projectDir);
  }
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

export async function resolveLocation(
  ctx: Context,
  scope: Scope,
  projectDirOption?: string,
): Promise<Location> {
  if (scope === 'global') {
    return { scope, manifestPath: globalManifestPath(ctx.paths) };
  }

  const requested = resolve(ctx.cwd, projectDirOption ?? '.');
  if (!(await isDirectory(requested))) {
    throw new UsageError(`${requested} is not a directory`);
  }
  const dir = await realpath(requested);
  const repository = await gitContext(dir);
  return {
    scope,
    manifestPath: projectManifestPath(dir),
    project: {
      dir,
      title: await projectTitle(dir),
      ...(repository ? { git: repository } : {}),
    },
  };
}

export async function readLocationManifest(
  ctx: Context,
  prompting: boolean,
  location: Location,
): Promise<Manifest | null> {
  const project = location.project;
  if (!project) return readManifest(location.manifestPath);

  const result = await readProjectManifest(location.manifestPath, {
    dir: project.dir,
    ...(project.git ? { gitExcludePath: project.git.excludePath } : {}),
  });
  for (const path of result?.ignored ?? []) {
    notify(
      ctx,
      prompting,
      `The recorded git exclude entries (${path}) belong to another repository, so they were ignored and left untouched.`,
      'warn',
    );
  }
  return result?.manifest ?? null;
}

export function dropUnknownBlocks(
  ctx: Context,
  prompting: boolean,
  library: BlockLibrary,
  ids: readonly string[],
): string[] {
  const known = new Set(library.blocks.map((block) => block.id));
  const dropped = ids.filter((id) => !known.has(id));
  if (dropped.length > 0) {
    notify(
      ctx,
      prompting,
      `Blocks no longer in the library were dropped: ${dropped.join(', ')}`,
      'warn',
    );
  }
  return ids.filter((id) => known.has(id));
}

export async function warnTrackedFiles(
  ctx: Context,
  prompting: boolean,
  plan: Plan,
  project: ProjectContext | undefined,
): Promise<void> {
  if (!project?.git) return;
  const root = project.git.root;
  const candidates = plan.actions
    .filter((action) => action.path.startsWith(project.dir))
    .map((action) => relative(root, action.path));
  if (candidates.length === 0) return;

  const tracked = await git(root, ['ls-files', '--', ...candidates]);
  if (tracked) {
    notify(
      ctx,
      prompting,
      `Already tracked by git, so keeping them local has no effect: ${tracked.split('\n').join(', ')}`,
      'warn',
    );
  }
}

export async function confirmAndApply(
  ctx: Context,
  plan: Plan,
  options: { yes: boolean; dryRun: boolean },
): Promise<{ code: number; applied: boolean }> {
  const prompting = ctx.interactive && !options.yes;
  const lines = describePlan(plan, ctx.paths.home);
  if (prompting) {
    clack.note(lines.join('\n') || 'Nothing to do', 'Plan');
  } else {
    lines.forEach((entry) => ctx.print(entry));
  }

  if (options.dryRun) {
    notify(ctx, prompting, 'Dry run: nothing was written.');
    return { code: 0, applied: false };
  }
  const blocked = conflicts(plan);
  if (!hasChanges(plan) && blocked.length === 0) {
    notify(ctx, prompting, 'Everything is up to date.');
    return { code: 0, applied: false };
  }
  if (!ctx.interactive && !options.yes) {
    ctx.print(
      'Re-run with --yes to apply these changes, or --dry-run to preview them.',
    );
    return { code: 1, applied: false };
  }
  if (prompting && !(await confirmApply())) {
    notify(ctx, true, 'Nothing was written.');
    return { code: 1, applied: false };
  }

  const outcome = await applyPlan(plan);
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
    notify(
      ctx,
      prompting,
      `Skipped ${planPath(plan, action.path, ctx.paths.home)}: ${action.reason ?? 'conflict'}`,
      'warn',
    );
  }
  return { code: outcome.skipped.length > 0 ? 1 : 0, applied: true };
}
