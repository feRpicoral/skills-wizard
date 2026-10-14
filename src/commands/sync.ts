import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { buildPlan } from '../install/plan.ts';
import { DEFAULT_SKILL_MODE } from '../skills/install.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import {
  confirmAndApply,
  fetchSkills,
  loadLibrary,
  readLocationManifest,
  reconcileManifestSelection,
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
  const previous = await readLocationManifest({ ctx, prompting, location });
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath({ path: location.manifestPath, home: ctx.paths.home })}; run agents-config init first.`,
    );
  }

  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const reconciled = await reconcileManifestSelection({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
  });
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.tools.length > 0 ? reconciled.skills : [],
  });
  const plan = await buildPlan({
    scope,
    selection: {
      tools: previous.tools,
      blocks: reconciled.blocks,
      skills: reconciled.skills,
      variables: reconciled.variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal: reconciled.keepLocal,
      skillMode: previous.options.skillMode ?? DEFAULT_SKILL_MODE,
      ...(reconciled.preset !== undefined ? { preset: reconciled.preset } : {}),
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
