import { withRequirements } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import {
  confirmAndApply,
  dropUnknownBlocks,
  loadLibrary,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  warnTrackedFiles,
} from './shared.ts';

interface SyncOptions {
  scope: Scope;
  projectDir?: string;
  yes: boolean;
  dryRun: boolean;
}

export async function runSync(
  ctx: Context,
  options: SyncOptions,
): Promise<number> {
  const prompting = ctx.interactive && !options.yes;
  const location = await resolveLocation(
    ctx,
    options.scope,
    options.projectDir,
  );
  const previous = await readLocationManifest(ctx, prompting, location);
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath(location.manifestPath, ctx.paths.home)}; run agents-config init first.`,
    );
  }

  const library = await loadLibrary(ctx);
  const known = dropUnknownBlocks(ctx, prompting, library, previous.blocks);
  const { ids: blocks, added } = withRequirements(library, known);
  if (added.length > 0) {
    notify(ctx, prompting, `Added required blocks: ${added.join(', ')}`);
  }
  const recordedLocal = previous.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  if (location.project && recordedLocal && !keepLocal) {
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  const plan = await buildPlan({
    scope: options.scope,
    selection: {
      tools: previous.tools,
      blocks,
      variables: previous.variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
  });
  if (keepLocal) await warnTrackedFiles(ctx, prompting, plan, location.project);

  const result = await confirmAndApply(ctx, plan, options);
  return result.code;
}
