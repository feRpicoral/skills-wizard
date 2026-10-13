import { withRequirements } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import { DEFAULT_SKILL_MODE } from '../skills/install.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import {
  confirmAndApply,
  dropUnavailableBlocks,
  dropUnavailableMcpServers,
  dropUnknownPreset,
  dropUnknownSkills,
  fetchSkills,
  loadLibrary,
  loadMcpServers,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  resolveVariables,
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
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const skills = dropUnknownSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.skills,
  });
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.tools.length > 0 ? skills : [],
  });
  const mcpCatalog = await loadMcpServers(ctx);
  const mcp = dropUnavailableMcpServers({
    ctx,
    prompting,
    catalog: mcpCatalog,
    names: previous.mcp,
    scope,
  });
  const recordedLocal = previous.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  if (location.project && recordedLocal && !keepLocal) {
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  const preset = dropUnknownPreset({
    ctx,
    prompting,
    preset: previous.options.preset,
  });
  const plan = await buildPlan({
    scope,
    selection: {
      tools: previous.tools,
      blocks,
      skills,
      mcp,
      variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal,
      skillMode: previous.options.skillMode ?? DEFAULT_SKILL_MODE,
      ...(preset !== undefined ? { preset } : {}),
      ...(previous.options.style !== undefined
        ? { style: previous.options.style }
        : {}),
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
    skillSources,
    mcpCatalog,
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
