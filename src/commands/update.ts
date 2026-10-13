import { styleText } from 'node:util';

import * as clack from '@clack/prompts';

import { withRequirements } from '../blocks/compose.ts';
import type { BlockLibrary } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import {
  AgentsConfigError,
  MissingVariablesError,
  RegistryError,
  SourceError,
  UsageError,
} from '../errors.ts';
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
import type { McpCatalog } from '../mcp/model.ts';
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
  dropUnavailableBlocks,
  dropUnavailableMcpServers,
  dropUnknownPreset,
  dropUnknownSkills,
  loadLibrary,
  loadMcpServers,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  resolveVariables,
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

type UpdateLocation = Awaited<ReturnType<typeof resolveLocation>>;

interface UpdateTarget {
  location: UpdateLocation;
  manifest: Manifest;
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

interface RestoreMovedParams {
  ctx: Context;
  prompting: boolean;
  cache: SourceCache;
  moved: readonly MovedSource[];
}

async function restoreMoved({
  ctx,
  prompting,
  cache,
  moved,
}: RestoreMovedParams): Promise<void> {
  for (const item of moved) {
    try {
      await restoreSource({ cache, repo: item.repo, commit: item.commit });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      notify({ ctx, prompting, message: error.message, level: 'warn' });
    }
  }
}

async function readRecordedProjects(
  ctx: Context,
  prompting: boolean,
): Promise<string[]> {
  try {
    return await readProjects(ctx.paths);
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    notify({
      ctx,
      prompting,
      message: `Skipping recorded projects: ${error.message}`,
      level: 'warn',
    });
    return [];
  }
}

interface SkipProjectParams {
  ctx: Context;
  prompting: boolean;
  projectDir: string;
  error: unknown;
}

function skipProject({
  ctx,
  prompting,
  projectDir,
  error,
}: SkipProjectParams): void {
  if (!(error instanceof AgentsConfigError)) throw error;
  notify({
    ctx,
    prompting,
    message: `Skipping ${displayPath({ path: projectDir, home: ctx.paths.home })}: ${error.message}`,
    level: 'warn',
  });
}

interface ProjectTargetParams {
  ctx: Context;
  prompting: boolean;
  projectDir: string;
}

async function projectTarget({
  ctx,
  prompting,
  projectDir,
}: ProjectTargetParams): Promise<UpdateTarget | null> {
  try {
    const location = await resolveLocation({
      ctx,
      scope: 'project',
      projectDir,
    });
    const manifest = await readLocationManifest(ctx, prompting, location);
    return manifest ? { location, manifest } : null;
  } catch (error) {
    skipProject({ ctx, prompting, projectDir, error });
    return null;
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
  mcpCatalog: McpCatalog;
  location: UpdateLocation;
  previous: Manifest;
}

async function planUpdateTarget({
  ctx,
  prompting,
  library,
  skillLibrary,
  skillSources,
  mcpCatalog,
  location,
  previous,
}: PlanUpdateTargetParams): Promise<Plan> {
  const knownBlocks = dropUnavailableBlocks({
    ctx,
    prompting,
    library,
    ids: previous.blocks,
    scope: location.scope,
  });
  const { ids: blocks, added } = withRequirements(library, knownBlocks);
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
  const skills = dropUnknownSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.skills,
  });
  const mcp = dropUnavailableMcpServers({
    ctx,
    prompting,
    catalog: mcpCatalog,
    names: previous.mcp,
    scope: location.scope,
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
  return buildPlan({
    scope: location.scope,
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

  const targets: UpdateTarget[] = [];
  if (globalManifest) {
    targets.push({ location: globalLocation, manifest: globalManifest });
  }

  const stale: string[] = [];
  for (const projectDir of await readRecordedProjects(ctx, prompting)) {
    if (!(await lstatIfExists(projectManifestPath(projectDir)))) {
      notify({
        ctx,
        prompting,
        message: `Skipping ${displayPath({ path: projectDir, home })}: no project manifest found, so it is forgotten once the update is applied.`,
      });
      stale.push(projectDir);
      continue;
    }
    const target = await projectTarget({ ctx, prompting, projectDir });
    if (target) targets.push(target);
  }

  if (targets.length === 0 && stale.length === 0) {
    throw new UsageError(
      'Nothing recorded to update; run agents-config init first.',
    );
  }

  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const mcpCatalog = await loadMcpServers(ctx);
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
  let keepSources = false;
  try {
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
        ctx.print(
          `${RISK_LABEL}  ${report.name} (${risk.file}): ${risk.detail}`,
        );
      }
    }

    const plans: Plan[] = [];
    for (const target of targets) {
      try {
        plans.push(
          await planUpdateTarget({
            ctx,
            prompting,
            library,
            skillLibrary,
            skillSources: sources,
            mcpCatalog,
            location: target.location,
            previous: target.manifest,
          }),
        );
      } catch (error) {
        if (target.location.project) {
          skipProject({
            ctx,
            prompting,
            projectDir: target.location.project.dir,
            error,
          });
        } else if (error instanceof MissingVariablesError) {
          notify({
            ctx,
            prompting,
            message: `Skipping the system-wide install: ${error.message}`,
            level: 'warn',
          });
        } else {
          throw error;
        }
      }
    }

    const planLines = plans.flatMap((plan) => describePlan(plan, home));
    if (prompting) {
      clack.note(planLines.join('\n') || 'Nothing to do', 'Plan');
    } else {
      planLines.forEach((line) => ctx.print(line));
    }
    for (const plan of plans) {
      for (const warning of plan.warnings ?? []) {
        notify({ ctx, prompting, message: warning, level: 'warn' });
      }
    }

    if (dryRun) {
      notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
      return 0;
    }
    const hasAnyWork =
      stale.length > 0 ||
      plans.some((plan) => hasChanges(plan) || conflicts(plan).length > 0);
    if (!hasAnyWork) {
      keepSources = true;
      notify({ ctx, prompting, message: 'Everything is up to date.' });
      return 0;
    }
    if (!ctx.interactive && !yes) {
      ctx.print(
        'Re-run with --yes to apply these changes, or --dry-run to preview them.',
      );
      return 1;
    }
    if (prompting && !(await confirmApply())) {
      notify({ ctx, prompting: true, message: 'Nothing was written.' });
      return 1;
    }

    keepSources = true;
    for (const projectDir of stale) {
      await forgetProject(ctx.paths, projectDir);
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
  } finally {
    if (!keepSources) await restoreMoved({ ctx, prompting, cache, moved });
  }
}
