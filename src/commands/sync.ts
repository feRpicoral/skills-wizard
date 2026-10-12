import * as clack from '@clack/prompts';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import { readManifest } from '../state/manifest.ts';
import {
  confirmAndApply,
  knownBlocks,
  loadLibrary,
  resolveLocation,
} from './shared.ts';

export interface SyncOptions {
  scope: Scope;
  projectDir?: string;
  yes: boolean;
  dryRun: boolean;
}

export async function runSync(
  ctx: Context,
  options: SyncOptions,
): Promise<number> {
  const interactive = ctx.interactive && !options.yes;
  const location = await resolveLocation(
    ctx,
    options.scope,
    options.projectDir,
  );
  const previous = await readManifest(location.manifestPath, location.baseDir);
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath(location.manifestPath, ctx.paths.home)}; run agents-config init first.`,
    );
  }

  const library = await loadLibrary(ctx);
  const { blocks, dropped } = knownBlocks(library, previous);
  if (dropped.length > 0) {
    const message = `Blocks no longer in the library were dropped: ${dropped.join(', ')}`;
    if (interactive) clack.log.warn(message);
    else ctx.print(message);
  }

  const plan = await buildPlan({
    scope: options.scope,
    selection: {
      tools: previous.tools,
      blocks,
      variables: previous.variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal: previous.options.keepLocal ?? false,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    now: ctx.now(),
    ...(location.projectDir ? { projectDir: location.projectDir } : {}),
    ...(location.projectTitle ? { projectTitle: location.projectTitle } : {}),
    ...(location.gitExcludePath
      ? { gitExcludePath: location.gitExcludePath }
      : {}),
  });

  const result = await confirmAndApply(ctx, plan, location, {
    interactive,
    dryRun: options.dryRun,
  });
  return result.code;
}
