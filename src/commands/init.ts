import {
  defaultBlockIds,
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
  promptTools,
  promptVariables,
} from '../prompts/selection.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
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

interface InitOptions {
  scope?: Scope;
  projectDir?: string;
  tools?: ToolId[];
  blocks?: string[];
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
  const outOfScope = library.blocks.filter(
    (block) => ids.includes(block.id) && !block.scopes.includes(scope),
  );
  if (outOfScope.length > 0) {
    throw new UsageError(
      `Blocks not available for ${scope} scope: ${outOfScope.map((block) => block.id).join(', ')}`,
    );
  }
}

function checkScopeOptions(scope: Scope, options: InitOptions): void {
  if (scope === 'project' && options.linkCommand !== undefined) {
    throw new UsageError(
      '--link-command only applies to system-wide installs.',
    );
  }
  if (scope === 'global' && options.keepLocal !== undefined) {
    throw new UsageError('--local only applies to project installs.');
  }
}

export async function runInit(
  ctx: Context,
  options: InitOptions,
): Promise<number> {
  const prompting = ctx.interactive && !options.yes;
  const scope = options.scope ?? (prompting ? await promptScope() : undefined);
  if (!scope) throw new UsageError('Pass --global or --project <dir>.');
  checkScopeOptions(scope, options);

  const projectDir =
    scope === 'project' && options.projectDir === undefined && prompting
      ? await promptProjectDir(ctx.cwd)
      : options.projectDir;
  const location = await resolveLocation(ctx, scope, projectDir);
  const library = await loadLibrary(ctx);
  const previous = await readLocationManifest(ctx, prompting, location);

  const initialTools =
    options.tools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  const tools = prompting
    ? await promptTools(scope, initialTools, ctx.paths)
    : initialTools;
  if (!prompting && tools.length === 0 && !previous) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  if (options.blocks) checkExplicitBlocks(library, options.blocks, scope);
  const initialBlocks =
    options.blocks ??
    (previous
      ? dropUnknownBlocks(ctx, prompting, library, previous.blocks)
      : defaultBlockIds(library, scope));
  const chosen = prompting
    ? await promptBlocks(library, scope, initialBlocks)
    : initialBlocks;
  const { ids: blocks, added } = withRequirements(library, chosen);
  if (added.length > 0) {
    notify(ctx, prompting, `Added required blocks: ${added.join(', ')}`);
  }

  const needed = requiredVariables(selectBlocks(library, blocks, scope));
  const unused = Object.keys(options.variables).filter(
    (name) => !needed.includes(name),
  );
  if (unused.length > 0) {
    notify(
      ctx,
      prompting,
      `Ignoring unused variables: ${unused.join(', ')}`,
      'warn',
    );
  }
  const known = await lookupVariables(needed, {
    ...previous?.variables,
    ...options.variables,
  });
  const variables = prompting ? await promptVariables(needed, known) : known;
  const missing = needed.filter((name) => !variables[name]?.trim());
  if (missing.length > 0) {
    throw new UsageError(
      `Missing variables: ${missing.map((name) => `--var ${name}=<value>`).join(' ')}`,
    );
  }

  const previousLink = previous?.options.linkCommand ?? false;
  const linkCommand =
    scope === 'global'
      ? (options.linkCommand ??
        (prompting
          ? await promptLinkCommand(previous ? previousLink : true, ctx.paths)
          : previousLink))
      : false;
  const git = location.project?.git;
  const previousLocal = previous?.options.keepLocal ?? false;
  if (options.keepLocal && !git) {
    throw new UsageError(
      `${location.project?.dir ?? ctx.cwd} is not in a git repository, so files cannot be kept local.`,
    );
  }
  if (
    location.project &&
    previousLocal &&
    !git &&
    options.keepLocal === undefined
  ) {
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  const keepLocal =
    scope === 'project' && git
      ? (options.keepLocal ??
        (prompting ? await promptKeepLocal(previousLocal) : previousLocal))
      : false;

  const plan = await buildPlan({
    scope,
    selection: { tools, blocks, variables, linkCommand, keepLocal },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
  });
  if (keepLocal) await warnTrackedFiles(ctx, prompting, plan, location.project);

  const result = await confirmAndApply(ctx, plan, {
    yes: options.yes,
    dryRun: options.dryRun,
  });
  if (
    result.applied &&
    linkCommand &&
    !ctx.searchPath.includes(ctx.paths.localBin)
  ) {
    notify(
      ctx,
      prompting,
      `${displayPath(ctx.paths.localBin, ctx.paths.home)} is not on your PATH; add it to run agents-config from any directory.`,
      'warn',
    );
  }
  return result.code;
}
