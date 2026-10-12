import { styleText } from 'node:util';

import * as clack from '@clack/prompts';

import { withRequirements } from '../blocks/compose.ts';
import type { BlockLibrary } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { SourceError, UsageError } from '../errors.ts';
import { applyPlan } from '../install/apply.ts';
import {
  conflicts,
  describePlan,
  displayPath,
  hasChanges,
  planPath,
} from '../install/describe.ts';
import { isDirectory, lstatIfExists } from '../install/fs.ts';
import { buildPlan, type Plan } from '../install/plan.ts';
import { confirmApply } from '../prompts/selection.ts';
import { type CatalogEntry, repositoryPaths } from '../skills/catalog.ts';
import { diffSkillTrees, hasDiff, type SkillDiff } from '../skills/diff.ts';
import {
  DEFAULT_SKILL_MODE,
  resolveSkillSources,
  type SkillSource,
} from '../skills/install.ts';
import {
  findSkill,
  loadSkillLibrary,
  type SkillLibrary,
} from '../skills/library.ts';
import { type RiskFlag, scanSkillRisks } from '../skills/risk.ts';
import {
  checkSource,
  ensureSource,
  restoreSource,
  type SourceCache,
  type SourceSpec,
  updateSource,
} from '../skills/sources.ts';
import { type Manifest, projectManifestPath } from '../state/manifest.ts';
import { forgetProject, readProjects } from '../state/projects.ts';
import {
  dropUnknownBlocks,
  dropUnknownSkills,
  loadLibrary,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  sourceCache,
} from './shared.ts';

export interface UpdateOptions {
  yes: boolean;
  dryRun: boolean;
}

interface MovedSource {
  repo: string;
  commit: string;
}

interface SkillChangeReport {
  name: string;
  diff: SkillDiff;
  risks: RiskFlag[];
}

const RISK_LABEL = styleText(['red', 'bold'], 'risk ');

async function findInstalledCopy(
  manifests: readonly Manifest[],
  name: string,
): Promise<string | null> {
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (
        entry.kind === 'skill' &&
        entry.name === name &&
        entry.install.mode === 'copy' &&
        (await isDirectory(entry.path))
      ) {
        return entry.path;
      }
    }
  }
  return null;
}

interface RefreshCatalogSourcesParams {
  ctx: Context;
  prompting: boolean;
  skillLibrary: SkillLibrary;
  names: readonly string[];
  cache: SourceCache;
}

async function refreshCatalogSources({
  ctx,
  prompting,
  skillLibrary,
  names,
  cache,
}: RefreshCatalogSourcesParams): Promise<MovedSource[]> {
  const specs = new Map<string, SourceSpec>();
  for (const name of names) {
    const skill = findSkill(skillLibrary, name);
    if (skill?.origin.type !== 'catalog') continue;
    const entry: CatalogEntry = skill.origin.entry;
    if (!specs.has(entry.repo)) {
      specs.set(entry.repo, {
        repo: entry.repo,
        ...(entry.ref ? { ref: entry.ref } : {}),
        paths: repositoryPaths(skillLibrary.catalog, entry.repo),
      });
    }
  }

  const moved: MovedSource[] = [];
  for (const spec of specs.values()) {
    try {
      await ensureSource(cache, spec);
      const check = await checkSource(cache, spec, { force: true });
      if (check.current !== check.latest) {
        const updated = await updateSource(cache, spec);
        if (updated.previous !== updated.current) {
          moved.push({ repo: spec.repo, commit: updated.previous });
        }
      }
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      notify({ ctx, prompting, message: error.message, level: 'warn' });
    }
  }
  return moved;
}

async function restoreMoved(
  cache: SourceCache,
  moved: readonly MovedSource[],
): Promise<void> {
  for (const item of moved) {
    await restoreSource({ cache, repo: item.repo, commit: item.commit });
  }
}

function formatDiffSummary(report: SkillChangeReport): string {
  const parts: string[] = [];
  if (report.diff.added.length > 0) {
    parts.push(`added ${report.diff.added.join(', ')}`);
  }
  if (report.diff.modified.length > 0) {
    parts.push(`modified ${report.diff.modified.join(', ')}`);
  }
  if (report.diff.removed.length > 0) {
    parts.push(`removed ${report.diff.removed.join(', ')}`);
  }
  return `${report.name}: ${parts.join('; ')}`;
}

async function collectChangeReports(
  manifests: readonly Manifest[],
  names: readonly string[],
  sources: ReadonlyMap<string, SkillSource>,
): Promise<SkillChangeReport[]> {
  const reports: SkillChangeReport[] = [];
  for (const name of names) {
    const source = sources.get(name);
    const installed = await findInstalledCopy(manifests, name);
    if (!source || !installed) continue;
    const diff = await diffSkillTrees({
      previousDir: installed,
      nextDir: source.dir,
    });
    if (!hasDiff(diff)) continue;
    const risks = await scanSkillRisks({
      previousDir: installed,
      nextDir: source.dir,
      precomputed: diff,
    });
    reports.push({ name, diff, risks });
  }
  return reports;
}

interface PlanUpdateTargetParams {
  ctx: Context;
  prompting: boolean;
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  skillSources: ReadonlyMap<string, SkillSource>;
  location: Awaited<ReturnType<typeof resolveLocation>>;
  previous: Manifest;
}

async function planUpdateTarget({
  ctx,
  prompting,
  library,
  skillLibrary,
  skillSources,
  location,
  previous,
}: PlanUpdateTargetParams): Promise<Plan> {
  const knownBlocks = dropUnknownBlocks({
    ctx,
    prompting,
    library,
    ids: previous.blocks,
  });
  const { ids: blocks, added } = withRequirements(library, knownBlocks);
  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }
  const skills = dropUnknownSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.skills,
  });
  const recordedLocal = previous.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  if (location.project && recordedLocal && !keepLocal) {
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  return buildPlan({
    scope: location.scope,
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
}

export async function runUpdate(
  ctx: Context,
  { yes, dryRun }: UpdateOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const home = ctx.paths.home;
  const globalLocation = await resolveLocation({ ctx, scope: 'global' });
  const globalManifest = await readLocationManifest(
    ctx,
    prompting,
    globalLocation,
  );

  const targets: {
    location: Awaited<ReturnType<typeof resolveLocation>>;
    manifest: Manifest;
  }[] = [];
  if (globalManifest) {
    targets.push({ location: globalLocation, manifest: globalManifest });
  }

  for (const projectDir of await readProjects(ctx.paths)) {
    if (!(await lstatIfExists(projectManifestPath(projectDir)))) {
      notify({
        ctx,
        prompting,
        message: `Skipping ${displayPath({ path: projectDir, home })}: no project manifest found.`,
      });
      if (!dryRun) await forgetProject(ctx.paths, projectDir);
      continue;
    }
    const location = await resolveLocation({
      ctx,
      scope: 'project',
      projectDir,
    });
    const manifest = await readLocationManifest(ctx, prompting, location);
    if (manifest) targets.push({ location, manifest });
  }

  if (targets.length === 0) {
    throw new UsageError(
      'Nothing recorded to update; run agents-config init first.',
    );
  }

  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const allSkills = [
    ...new Set(
      targets.flatMap(({ manifest }) =>
        manifest.tools.length > 0
          ? manifest.skills.filter((name) => findSkill(skillLibrary, name))
          : [],
      ),
    ),
  ];

  const cache = sourceCache(ctx);
  const moved = await refreshCatalogSources({
    ctx,
    prompting,
    skillLibrary,
    names: allSkills,
    cache,
  });
  const { sources, problems } = await resolveSkillSources({
    library: skillLibrary,
    names: allSkills,
    cache,
    fetch: true,
  });
  for (const [name, problem] of problems) {
    notify({
      ctx,
      prompting,
      message: `Skipping the ${name} skill: ${problem}`,
      level: 'warn',
    });
  }

  const manifests = targets.map((target) => target.manifest);
  const changeReports = await collectChangeReports(
    manifests,
    allSkills,
    sources,
  );
  for (const report of changeReports) {
    notify({ ctx, prompting, message: formatDiffSummary(report) });
    for (const risk of report.risks) {
      ctx.print(`${RISK_LABEL}  ${report.name} (${risk.file}): ${risk.detail}`);
    }
  }

  const plans: Plan[] = [];
  for (const target of targets) {
    plans.push(
      await planUpdateTarget({
        ctx,
        prompting,
        library,
        skillLibrary,
        skillSources: sources,
        location: target.location,
        previous: target.manifest,
      }),
    );
  }

  const planLines = plans.flatMap((plan) => describePlan(plan, home));
  if (prompting) {
    clack.note(planLines.join('\n') || 'Nothing to do', 'Plan');
  } else {
    planLines.forEach((line) => ctx.print(line));
  }

  if (dryRun) {
    await restoreMoved(cache, moved);
    notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
    return 0;
  }
  const hasAnyWork = plans.some(
    (plan) => hasChanges(plan) || conflicts(plan).length > 0,
  );
  if (!hasAnyWork) {
    notify({ ctx, prompting, message: 'Everything is up to date.' });
    return 0;
  }
  if (!ctx.interactive && !yes) {
    await restoreMoved(cache, moved);
    ctx.print(
      'Re-run with --yes to apply these changes, or --dry-run to preview them.',
    );
    return 1;
  }
  if (prompting && !(await confirmApply())) {
    await restoreMoved(cache, moved);
    notify({ ctx, prompting: true, message: 'Nothing was written.' });
    return 1;
  }

  let changed = 0;
  let failed = 0;
  for (const plan of plans) {
    const outcome = await applyPlan(plan);
    changed += outcome.applied.filter(
      (action) => action.change.type !== 'none',
    ).length;
    for (const action of outcome.skipped) {
      failed += 1;
      notify({
        ctx,
        prompting,
        message: `Skipped ${planPath({ plan, path: action.path, home })}: ${action.reason ?? 'conflict'}`,
        level: 'warn',
      });
    }
    for (const failure of outcome.setupFailures) {
      failed += 1;
      notify({
        ctx,
        prompting,
        message: `Setup in ${planPath({ plan, path: failure.path, home })} did not finish: ${failure.message}`,
        level: 'warn',
      });
    }
  }

  const summary = `Applied ${changed} change${changed === 1 ? '' : 's'}.`;
  if (prompting) clack.outro(summary);
  else ctx.print(summary);
  return failed > 0 ? 1 : 0;
}
