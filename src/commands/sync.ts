import {
  requiredVariables,
  selectBlocks,
  withRequirements,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import { lookupVariables } from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import { promptVariables } from '../prompts/selection.ts';
import {
  confirmAndApply,
  dropUnavailableBlocks,
  loadLibrary,
  type Location,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  setVariablesCommand,
  warnTrackedFiles,
} from './shared.ts';

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
async function resolveVariables({
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
    throw new UsageError(
      `The blocks now use variables with no recorded value: ${unresolved.join(', ')}. Set them with ${setVariablesCommand({ ctx, location, names: unresolved })}`,
    );
  }
  ctx.print(
    `Using looked-up values for new variables: ${missing.map((name) => `${name}=${found[name] ?? ''}`).join(', ')}`,
  );
  return found;
}

interface SyncOptions {
  scope: Scope;
  projectDir?: string;
  yes: boolean;
  dryRun: boolean;
}

export async function runSync(
  ctx: Context,
  { scope, projectDir, ...confirmOptions }: SyncOptions,
): Promise<number> {
  const prompting = ctx.interactive && !confirmOptions.yes;
  const location = await resolveLocation({
    ctx,
    scope,
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  const previous = await readLocationManifest(ctx, prompting, location);
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath({ path: location.manifestPath, home: ctx.paths.home })}; run agents-config init first.`,
    );
  }

  const library = await loadLibrary(ctx);
  const known = dropUnavailableBlocks({
    ctx,
    prompting,
    library,
    ids: previous.blocks,
    scope,
  });
  const { ids: blocks, added } = withRequirements(library, known);
  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }
  const variables = await resolveVariables({
    ctx,
    prompting,
    library,
    blocks,
    location,
    recorded: previous.variables,
  });
  const recordedLocal = previous.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  if (location.project && recordedLocal && !keepLocal) {
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  const plan = await buildPlan({
    scope,
    selection: {
      tools: previous.tools,
      blocks,
      variables,
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
  if (keepLocal) {
    await warnTrackedFiles({
      ctx,
      prompting,
      plan,
      ...(location.project ? { project: location.project } : {}),
    });
  }

  const result = await confirmAndApply(ctx, plan, confirmOptions);
  return result.code;
}
