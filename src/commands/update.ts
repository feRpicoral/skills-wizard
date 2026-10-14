import type { BlockLibrary } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import {
  AgentsConfigError,
  MissingVariablesError,
  RegistryError,
  UsageError,
} from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { lstatIfExists } from '../install/fs.ts';
import { buildPlan, type Plan } from '../install/plan.ts';
import type { McpCatalog } from '../mcp/model.ts';
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
import { type Manifest, projectManifestPath } from '../state/manifest.ts';
import { forgetProject, readProjects } from '../state/projects.ts';
import {
  confirmAndApplyPlans,
  loadLibrary,
  loadMcpServers,
  type Location,
  notify,
  readLocationManifest,
  reconcileManifestSelection,
  resolveLocation,
  sourceCache,
} from './shared.ts';
import { collectChangeReports, printChangeReports } from './update-report.ts';
import { refreshCatalogSources, restoreMoved } from './update-sources.ts';

export interface UpdateOptions {
  yes: boolean;
  dryRun: boolean;
}

interface UpdateTarget {
  location: Location;
  manifest: Manifest;
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
    const manifest = await readLocationManifest({ ctx, prompting, location });
    return manifest ? { location, manifest } : null;
  } catch (error) {
    skipProject({ ctx, prompting, projectDir, error });
    return null;
  }
}

async function discoverUpdateTargets(
  ctx: Context,
  prompting: boolean,
): Promise<{ targets: UpdateTarget[]; stale: string[] }> {
  const home = ctx.paths.home;
  const globalLocation = await resolveLocation({ ctx, scope: 'global' });
  const globalManifest = await readLocationManifest({
    ctx,
    prompting,
    location: globalLocation,
  });

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
  return { targets, stale };
}

interface PlanUpdateTargetParams {
  ctx: Context;
  prompting: boolean;
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  mcpCatalog: McpCatalog;
  skillSources: ReadonlyMap<string, SkillSource>;
  location: Location;
  previous: Manifest;
}

async function planUpdateTarget({
  ctx,
  prompting,
  library,
  skillLibrary,
  mcpCatalog,
  skillSources,
  location,
  previous,
}: PlanUpdateTargetParams): Promise<Plan> {
  const reconciled = await reconcileManifestSelection({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
    mcpCatalog,
  });
  return buildPlan({
    scope: location.scope,
    selection: {
      tools: previous.tools,
      blocks: reconciled.blocks,
      skills: reconciled.skills,
      mcp: reconciled.mcp,
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
    mcpCatalog,
  });
}

interface BuildUpdatePlansParams {
  ctx: Context;
  prompting: boolean;
  targets: readonly UpdateTarget[];
  library: BlockLibrary;
  skillLibrary: SkillLibrary;
  mcpCatalog: McpCatalog;
  sources: ReadonlyMap<string, SkillSource>;
}

async function buildUpdatePlans({
  ctx,
  prompting,
  targets,
  library,
  skillLibrary,
  mcpCatalog,
  sources,
}: BuildUpdatePlansParams): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const target of targets) {
    try {
      plans.push(
        await planUpdateTarget({
          ctx,
          prompting,
          library,
          skillLibrary,
          mcpCatalog,
          skillSources: sources,
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
  return plans;
}

export async function runUpdate(
  ctx: Context,
  { yes, dryRun }: UpdateOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const { targets, stale } = await discoverUpdateTargets(ctx, prompting);
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
    const reports = await collectChangeReports(manifests, allSkills, sources);
    printChangeReports(ctx, prompting, reports);

    const plans = await buildUpdatePlans({
      ctx,
      prompting,
      targets,
      library,
      skillLibrary,
      mcpCatalog,
      sources,
    });
    const hasExtraWork = stale.length > 0;
    const hasAnyWork =
      hasExtraWork ||
      plans.some((plan) =>
        plan.actions.some((action) => action.status !== 'unchanged'),
      ) ||
      plans.some((plan) => plan.manifestStatus !== 'unchanged');

    const result = await confirmAndApplyPlans(ctx, plans, {
      yes,
      dryRun,
      hasExtraWork,
      alwaysCountSummary: true,
      beforeApply: async () => {
        keepSources = true;
        for (const projectDir of stale) {
          await forgetProject(ctx.paths, projectDir);
        }
      },
    });
    if (!hasAnyWork && !dryRun) {
      keepSources = true;
    }
    return result.code;
  } finally {
    if (!keepSources) await restoreMoved({ ctx, prompting, cache, moved });
  }
}
