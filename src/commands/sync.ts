import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import { promptVariables } from '../prompts/selection.ts';
import {
  confirmAndApply,
  loadLibrary,
  type Location,
  notifyLeftGit,
  notifyReconciledBlocks,
  readLocationManifest,
  type ReconciledManifest,
  reconcileManifest,
  resolveLocation,
  setVariablesCommand,
  warnTrackedFiles,
} from './shared.ts';

interface ResolveVariablesParams {
  ctx: Context;
  prompting: boolean;
  location: Location;
  recorded: Readonly<Record<string, string>>;
  reconciled: ReconciledManifest;
}

// A block edited to use a new variable has no recorded value yet. Look it up
// (or ask for it) the way init does, and stop with the init command otherwise.
async function resolveVariables({
  ctx,
  prompting,
  location,
  recorded,
  reconciled: { missingVariables, foundVariables, unresolvedVariables },
}: ResolveVariablesParams): Promise<Record<string, string>> {
  if (missingVariables.length === 0) return { ...recorded };
  if (prompting) {
    return {
      ...recorded,
      ...(await promptVariables(missingVariables, foundVariables)),
    };
  }
  if (unresolvedVariables.length > 0) {
    throw new UsageError(
      `The blocks now use variables with no recorded value: ${unresolvedVariables.join(', ')}. Set them with ${setVariablesCommand({ ctx, location, names: unresolvedVariables })}`,
    );
  }
  ctx.print(
    `Using looked-up values for new variables: ${missingVariables.map((name) => `${name}=${foundVariables[name] ?? ''}`).join(', ')}`,
  );
  return foundVariables;
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
  const previous = await readLocationManifest({ ctx, prompting, location });
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath({ path: location.manifestPath, home: ctx.paths.home })}; run agents-config init first.`,
    );
  }

  const library = await loadLibrary(ctx);
  const reconciled = await reconcileManifest({
    manifest: previous,
    library,
    location,
    lookupEnv: { home: ctx.paths.home, searchPath: ctx.searchPath },
  });
  notifyReconciledBlocks({ ctx, prompting, scope, reconciled });
  const variables = await resolveVariables({
    ctx,
    prompting,
    location,
    recorded: previous.variables,
    reconciled,
  });
  if (reconciled.leftGit && location.project) {
    notifyLeftGit({ ctx, prompting, projectDir: location.project.dir });
  }
  const plan = await buildPlan({
    scope,
    selection: {
      tools: previous.tools,
      blocks: reconciled.blocks,
      variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal: reconciled.keepLocal,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
  });
  if (reconciled.keepLocal) {
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
