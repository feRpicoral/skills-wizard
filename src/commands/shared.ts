import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
  displayPath,
  hasChanges,
} from '../install/describe.ts';
import { readTextIfExists } from '../install/fs.ts';
import type { Plan } from '../install/plan.ts';
import { confirmApply } from '../prompts/selection.ts';
import {
  globalManifestPath,
  type Manifest,
  projectManifestPath,
} from '../state/manifest.ts';

const run = promisify(execFile);

export interface Location {
  scope: Scope;
  manifestPath: string;
  baseDir?: string;
  projectDir?: string;
  projectTitle?: string;
  gitExcludePath?: string;
}

export async function loadLibrary(ctx: Context): Promise<BlockLibrary> {
  return loadBlockLibrary(join(ctx.repoRoot, 'blocks'));
}

async function projectTitle(projectDir: string): Promise<string> {
  const manifest = await readTextIfExists(join(projectDir, 'package.json'));
  if (manifest !== null) {
    try {
      const parsed = JSON.parse(manifest) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        return parsed.name.trim();
      }
    } catch {
      return basename(projectDir);
    }
  }
  return basename(projectDir);
}

async function gitExcludePath(projectDir: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      'git',
      ['rev-parse', '--git-path', 'info/exclude'],
      { cwd: projectDir },
    );
    return resolve(projectDir, stdout.trim());
  } catch {
    return undefined;
  }
}

export async function resolveLocation(
  ctx: Context,
  scope: Scope,
  projectDirOption?: string,
): Promise<Location> {
  if (scope === 'global') {
    return { scope, manifestPath: globalManifestPath(ctx.paths) };
  }

  const projectDir = resolve(ctx.cwd, projectDirOption ?? '.');
  const stats = await stat(projectDir).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new UsageError(`${projectDir} is not a directory`);
  }
  const excludePath = await gitExcludePath(projectDir);
  return {
    scope,
    manifestPath: projectManifestPath(projectDir),
    baseDir: projectDir,
    projectDir,
    projectTitle: await projectTitle(projectDir),
    ...(excludePath ? { gitExcludePath: excludePath } : {}),
  };
}

export function knownBlocks(
  library: BlockLibrary,
  manifest: Manifest,
): { blocks: string[]; dropped: string[] } {
  const known = new Set(library.blocks.map((block) => block.id));
  return {
    blocks: manifest.blocks.filter((id) => known.has(id)),
    dropped: manifest.blocks.filter((id) => !known.has(id)),
  };
}

function report(ctx: Context, interactive: boolean, message: string) {
  if (interactive) clack.log.info(message);
  else ctx.print(message);
}

export async function confirmAndApply(
  ctx: Context,
  plan: Plan,
  location: Location,
  options: { interactive: boolean; dryRun: boolean },
): Promise<{ code: number; applied: boolean }> {
  const lines = describePlan(plan, ctx.paths.home, location.projectDir);
  if (options.interactive) {
    clack.note(lines.join('\n') || 'Nothing to do', 'Plan');
  } else {
    lines.forEach((line) => ctx.print(line));
  }

  if (options.dryRun) {
    report(ctx, options.interactive, 'Dry run: nothing was written.');
    return { code: 0, applied: false };
  }

  const blocked = conflicts(plan);
  if (!hasChanges(plan) && blocked.length === 0) {
    await applyPlan(plan, location.manifestPath, location.baseDir);
    report(ctx, options.interactive, 'Everything is up to date.');
    return { code: 0, applied: true };
  }

  if (options.interactive && !(await confirmApply())) {
    report(ctx, true, 'Nothing was written.');
    return { code: 1, applied: false };
  }

  const outcome = await applyPlan(
    plan,
    location.manifestPath,
    location.baseDir,
  );
  const changed = outcome.applied.filter(
    (action) => action.change.type !== 'none',
  ).length;
  const summary = `Applied ${changed} change${changed === 1 ? '' : 's'}; manifest at ${displayPath(location.manifestPath, ctx.paths.home)}.`;
  if (options.interactive) clack.outro(summary);
  else ctx.print(summary);

  for (const action of outcome.skipped) {
    const message = `Skipped ${displayPath(action.path, ctx.paths.home)}: ${action.reason ?? 'conflict'}`;
    if (options.interactive) clack.log.warn(message);
    else ctx.print(message);
  }
  return { code: outcome.skipped.length > 0 ? 1 : 0, applied: true };
}
