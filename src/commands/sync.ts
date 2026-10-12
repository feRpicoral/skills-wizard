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
  dropUnknownBlocks,
  dropUnknownSkills,
  fetchSkills,
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
  const known = dropUnknownBlocks({
    ctx,
    prompting,
    library,
    ids: previous.blocks,
  });
  const { ids: blocks, added } = withRequirements(library, known);
  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }
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
      skills,
      variables: previous.variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal,
      skillMode: previous.options.skillMode ?? DEFAULT_SKILL_MODE,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
    skillSources,
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
