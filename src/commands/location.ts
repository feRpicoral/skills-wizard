import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import type { Environment } from '../env.ts';
import { UsageError } from '../errors.ts';
import {
  isDirectory,
  isInside,
  readTextIfExists,
  realLocation,
  statIfExists,
} from '../install/fs.ts';
import type { Plan, ProjectContext } from '../install/plan.ts';
import { skillFolders } from '../install/targets.ts';
import { detectProject, type ProjectDetection } from '../project/detect.ts';
import { buildProjectSeed } from '../project/seed.ts';
import {
  checkSkillEntries,
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
  detection?: ProjectDetection;
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

interface GitQueryParams {
  projectDir: string;
  args: string[];
  env: Environment;
}

async function git({
  projectDir,
  args,
  env,
}: GitQueryParams): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: projectDir, env });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitContext(
  projectDir: string,
  env: Environment,
): Promise<ProjectContext['git']> {
  const root = await git({
    projectDir,
    args: ['rev-parse', '--show-toplevel'],
    env,
  });
  const excludePath = await git({
    projectDir,
    args: ['rev-parse', '--git-path', 'info/exclude'],
    env,
  });
  if (!root || !excludePath) return undefined;
  return { root, excludePath: resolve(projectDir, excludePath) };
}

export interface ResolveLocationParams {
  ctx: Context;
  scope: Scope;
  projectDir?: string;
  detect?: boolean;
}

/**
 * Resolves the target install `Location` (`manifestPath`, `project` context,
 * git repository metadata, and optional `ProjectDetection` + `AGENTS.md` seed)
 * for `global` or `project` scope.
 *
 * Full project stack detection runs when `detect` is `true` (used by `init`) or
 * when `AGENTS.md` does not yet have a non-empty preamble.
 */
export async function resolveLocation({
  ctx,
  scope,
  projectDir,
  detect = false,
}: ResolveLocationParams): Promise<Location> {
  if (scope === 'global') {
    return { scope, manifestPath: globalManifestPath(ctx.paths) };
  }

  const requested = resolve(ctx.cwd, projectDir ?? '.');
  if (!(await isDirectory(requested))) {
    throw new UsageError(`${requested} is not a directory`);
  }
  const dir = await realpath(requested);
  const repository = await gitContext(dir, ctx.sources.env);
  const existingAgentsMd = await readTextIfExists(join(dir, 'AGENTS.md'));
  const needsSeed = !existingAgentsMd?.trim();

  if (detect || needsSeed) {
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

async function readRecordedManifest({
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

export async function readLocationManifest({
  ctx,
  prompting,
  location,
}: ReadLocationManifestParams): Promise<Manifest | null> {
  const manifest = await readRecordedManifest({ ctx, prompting, location });
  const folders = manifest
    ? skillFolders({
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
  return manifest;
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

  const tracked = await git({
    projectDir: root,
    args: ['ls-files', '--', ...candidates],
    env: ctx.sources.env,
  });
  if (tracked) {
    notify({
      ctx,
      prompting,
      message: `Already tracked by git, so keeping them local has no effect: ${tracked.split('\n').join(', ')}`,
      level: 'warn',
    });
  }
}
