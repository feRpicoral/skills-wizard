import {
  defaultBlockIds,
  requiredVariables,
  selectBlocks,
} from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import { lookupVariables } from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
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
import { readManifest } from '../state/manifest.ts';
import { recordProject } from '../state/projects.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import { confirmAndApply, loadLibrary, resolveLocation } from './shared.ts';

export interface InitOptions {
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

export async function runInit(
  ctx: Context,
  options: InitOptions,
): Promise<number> {
  const interactive = ctx.interactive && !options.yes;
  const scope =
    options.scope ?? (interactive ? await promptScope() : undefined);
  if (!scope) throw new UsageError('Pass --global or --project <dir>.');

  const projectDir =
    scope === 'project' && options.projectDir === undefined && interactive
      ? await promptProjectDir(ctx.cwd)
      : options.projectDir;
  const location = await resolveLocation(ctx, scope, projectDir);
  const library = await loadLibrary(ctx);
  const previous = await readManifest(location.manifestPath, location.baseDir);

  const initialTools =
    options.tools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  const tools = interactive
    ? await promptTools(scope, initialTools, ctx.paths)
    : initialTools;
  if (!interactive && tools.length === 0) {
    throw new UsageError('No tools selected or detected; pass --tools.');
  }

  const initialBlocks =
    options.blocks ?? previous?.blocks ?? defaultBlockIds(library, scope);
  const blocks = interactive
    ? await promptBlocks(library, scope, initialBlocks)
    : initialBlocks;

  const needed = requiredVariables(selectBlocks(library, blocks, scope));
  const known = await lookupVariables(needed, {
    ...previous?.variables,
    ...options.variables,
  });
  const variables = interactive ? await promptVariables(needed, known) : known;
  const missing = needed.filter((name) => !variables[name]?.trim());
  if (missing.length > 0) {
    throw new UsageError(
      `Missing variables: ${missing.map((name) => `--var ${name}=<value>`).join(' ')}`,
    );
  }

  const linkCommand =
    scope === 'global'
      ? (options.linkCommand ??
        (interactive
          ? await promptLinkCommand(
              previous?.options.linkCommand ?? true,
              ctx.paths,
            )
          : (previous?.options.linkCommand ?? false)))
      : false;
  const keepLocal =
    scope === 'project'
      ? (options.keepLocal ??
        (interactive && location.gitExcludePath
          ? await promptKeepLocal(previous?.options.keepLocal ?? false)
          : (previous?.options.keepLocal ?? false)))
      : false;
  if (keepLocal && !location.gitExcludePath) {
    throw new UsageError(
      `${location.projectDir ?? ctx.cwd} is not a git repository, so files cannot be kept local.`,
    );
  }

  const plan = await buildPlan({
    scope,
    selection: { tools, blocks, variables, linkCommand, keepLocal },
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
  if (result.applied && location.projectDir) {
    await recordProject(ctx.paths, location.projectDir);
  }
  return result.code;
}
