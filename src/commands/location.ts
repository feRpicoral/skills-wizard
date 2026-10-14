import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import {
  isDirectory,
  isInside,
  readTextIfExists,
  realLocation,
  statIfExists,
} from '../install/fs.ts';
import type { Plan, ProjectContext } from '../install/plan.ts';
import {
  globalManifestPath,
  type Manifest,
  projectManifestPath,
  readGlobalManifest,
  readProjectManifest,
} from '../state/manifest.ts';
import { notify } from './output.ts';

const run = promisify(execFile);

export interface Location {
  scope: Scope;
  manifestPath: string;
  project?: ProjectContext;
}

async function readPackageJson(projectDir: string): Promise<string | null> {
  const location = await realLocation(join(projectDir, 'package.json'));
  if (location === null || !isInside({ dir: projectDir, path: location })) {
    return null;
  }
  if (!(await statIfExists(location))?.isFile()) return null;
  return readTextIfExists(location);
}

async function projectTitle(projectDir: string): Promise<string> {
  const packageJson = await readPackageJson(projectDir);
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

export interface ResolveLocationParams {
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

export interface ReadLocationManifestParams {
  ctx: Context;
  prompting: boolean;
  location: Location;
}

export async function readLocationManifest({
  ctx,
  prompting,
  location: { manifestPath, project },
}: ReadLocationManifestParams): Promise<Manifest | null> {
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

export interface WarnTrackedFilesParams {
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
    .filter((action) => isInside({ dir: project.dir, path: action.path }))
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
