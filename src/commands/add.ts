import { styleText } from 'node:util';

import { defaultBlockIds, withRequirements } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import {
  CatalogError,
  isSystemError,
  SourceError,
  UsageError,
} from '../errors.ts';
import {
  fsErrorReason,
  readTextIfExists,
  removePath,
  writeTextAtomic,
} from '../install/fs.ts';
import { buildPlan } from '../install/plan.ts';
import {
  confirmApply,
  promptAddQuery,
  promptDiscoveredCandidate,
  promptRepoSkillLocation,
  promptScope,
} from '../prompts/selection.ts';
import {
  appendCatalogEntries,
  type Catalog,
  type CatalogEntry,
  catalogPath,
  extendCatalog,
  repositoryPaths,
} from '../skills/catalog.ts';
import {
  type DiscoverSource,
  type DiscoveryCandidate,
  inspectDiscoveredSkill,
  locateSkillsInRepo,
  parseSkillTarget,
  type ResolvedDiscoveredSkill,
  searchAwesomeIndex,
  searchSkillsSh,
} from '../skills/discover.ts';
import { DEFAULT_SKILL_MODE, resolveSkillSources } from '../skills/install.ts';
import { loadSkillLibrary, type SkillLibrary } from '../skills/library.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  confirmAndApply,
  dropUnavailableBlocks,
  dropUnknownPreset,
  dropUnknownSkills,
  loadLibrary,
  type Location,
  notify,
  readLocationManifest,
  resolveLocation,
  resolveVariables,
  sourceCache,
} from './shared.ts';

export interface AddOptions {
  target?: string;
  source?: DiscoverSource;
  category?: string;
  ref?: string;
  includeOffensive?: boolean;
  install?: boolean;
  scope?: Scope;
  projectDir?: string;
  tools?: ToolId[];
  yes: boolean;
  dryRun: boolean;
}

const DEFAULT_ADD_CATEGORY = 'workflow';
const WARN_LABEL = styleText('yellow', 'warn ');
const RISK_LABEL = styleText(['red', 'bold'], 'risk ');

interface ResolveEffectiveRefParams {
  catalog: Catalog;
  repo: string;
  requestedRef?: string;
  urlRef?: string;
}

function resolveEffectiveRef({
  catalog,
  repo,
  requestedRef,
  urlRef,
}: ResolveEffectiveRefParams): string | undefined {
  if (
    requestedRef !== undefined &&
    urlRef !== undefined &&
    requestedRef !== urlRef
  ) {
    throw new UsageError(
      `Conflicting refs: URL specifies "${urlRef}" but --ref specifies "${requestedRef}"`,
    );
  }
  const explicitRef = requestedRef ?? urlRef;
  const existing = catalog.skills.find((entry) => entry.repo === repo);
  if (existing !== undefined) {
    if (explicitRef !== undefined && explicitRef !== existing.ref) {
      throw new CatalogError(
        `Every skill from ${repo} in catalog.yaml must use the same ref (${existing.ref ?? 'default branch'})`,
      );
    }
    return existing.ref;
  }
  return explicitRef;
}

interface SearchCandidatesParams {
  ctx: Context;
  prompting: boolean;
  query: string;
  source: DiscoverSource;
  category?: string;
  includeOffensive: boolean;
}

async function searchCandidates({
  ctx,
  prompting,
  query,
  source,
  category,
  includeOffensive,
}: SearchCandidatesParams): Promise<DiscoveryCandidate[]> {
  const cache = sourceCache(ctx);
  const rawBaseUrl = ctx.sources.skillsShUrl;
  const baseUrl = typeof rawBaseUrl === 'function' ? rawBaseUrl() : rawBaseUrl;
  const fetchFn = ctx.sources.fetch;

  if (source === 'skills-sh') {
    return searchSkillsSh({
      query,
      ...(baseUrl ? { baseUrl } : {}),
      ...(fetchFn ? { fetchFn } : {}),
    });
  }
  if (source === 'awesome') {
    return searchAwesomeIndex({
      cache,
      query,
      ...(category ? { category } : {}),
      includeOffensive,
    });
  }

  const [skillsShOutcome, awesomeOutcome] = await Promise.allSettled([
    searchSkillsSh({
      query,
      ...(baseUrl ? { baseUrl } : {}),
      ...(fetchFn ? { fetchFn } : {}),
    }),
    searchAwesomeIndex({
      cache,
      query,
      ...(category ? { category } : {}),
      includeOffensive,
    }),
  ]);

  if (
    skillsShOutcome.status === 'rejected' &&
    awesomeOutcome.status === 'rejected'
  ) {
    throw skillsShOutcome.reason;
  }
  if (skillsShOutcome.status === 'rejected') {
    const reason = skillsShOutcome.reason as unknown;
    if (!(reason instanceof SourceError)) throw reason;
    notify({ ctx, prompting, message: reason.message, level: 'warn' });
  }
  if (awesomeOutcome.status === 'rejected') {
    const reason = awesomeOutcome.reason as unknown;
    if (!(reason instanceof SourceError)) throw reason;
    notify({ ctx, prompting, message: reason.message, level: 'warn' });
  }

  const combined = [
    ...(skillsShOutcome.status === 'fulfilled' ? skillsShOutcome.value : []),
    ...(awesomeOutcome.status === 'fulfilled' ? awesomeOutcome.value : []),
  ];
  const seen = new Set<string>();
  const deduplicated: DiscoveryCandidate[] = [];
  for (const item of combined) {
    const key = `${item.repo}@${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(item);
  }
  return deduplicated;
}

interface ResolveTargetCandidateParams {
  ctx: Context;
  prompting: boolean;
  skillLibrary: SkillLibrary;
  rawTarget: string;
  source: DiscoverSource;
  requestedCategory?: string;
  requestedRef?: string;
  includeOffensive: boolean;
}

async function resolveTargetSkill({
  ctx,
  prompting,
  skillLibrary,
  rawTarget,
  source,
  requestedCategory,
  requestedRef,
  includeOffensive,
}: ResolveTargetCandidateParams): Promise<ResolvedDiscoveredSkill> {
  const cache = sourceCache(ctx);
  const { catalog } = skillLibrary;
  const parsed = parseSkillTarget(rawTarget);

  if (parsed.kind === 'github-path') {
    const ref = resolveEffectiveRef({
      catalog,
      repo: parsed.repo,
      ...(requestedRef ? { requestedRef } : {}),
      ...(parsed.ref ? { urlRef: parsed.ref } : {}),
    });
    return inspectDiscoveredSkill({
      cache,
      repo: parsed.repo,
      path: parsed.path,
      ...(ref ? { ref } : {}),
      ...(requestedCategory ? { category: requestedCategory } : {}),
      existingPaths: repositoryPaths(catalog, parsed.repo),
    });
  }

  if (parsed.kind === 'repo-skill') {
    const ref = resolveEffectiveRef({
      catalog,
      repo: parsed.repo,
      ...(requestedRef ? { requestedRef } : {}),
    });
    const existingPaths = repositoryPaths(catalog, parsed.repo);
    const [located] = await locateSkillsInRepo({
      cache,
      repo: parsed.repo,
      ...(ref ? { ref } : {}),
      expectedSkillName: parsed.skillName,
      existingPaths,
    });
    if (!located) {
      throw new SourceError(
        `Skill "${parsed.skillName}" was not found in ${parsed.repo}`,
      );
    }
    return inspectDiscoveredSkill({
      cache,
      repo: parsed.repo,
      path: located.path,
      ...(ref ? { ref } : {}),
      expectedName: parsed.skillName,
      ...(requestedCategory ? { category: requestedCategory } : {}),
      existingPaths,
    });
  }

  if (parsed.kind === 'repo') {
    const ref = resolveEffectiveRef({
      catalog,
      repo: parsed.repo,
      ...(requestedRef ? { requestedRef } : {}),
    });
    const existingPaths = repositoryPaths(catalog, parsed.repo);
    const locations = await locateSkillsInRepo({
      cache,
      repo: parsed.repo,
      ...(ref ? { ref } : {}),
      existingPaths,
    });
    let chosen = locations[0];
    if (locations.length > 1) {
      if (!prompting) {
        throw new UsageError(
          `Repository ${parsed.repo} contains multiple skills (${locations.map((item) => item.name).join(', ')}); specify ${parsed.repo}@<skill-name>`,
        );
      }
      chosen = await promptRepoSkillLocation({
        repo: parsed.repo,
        locations,
      });
    }
    if (!chosen) {
      throw new SourceError(`No valid SKILL.md found in ${parsed.repo}`);
    }
    return inspectDiscoveredSkill({
      cache,
      repo: parsed.repo,
      path: chosen.path,
      ...(ref ? { ref } : {}),
      expectedName: chosen.name,
      ...(requestedCategory ? { category: requestedCategory } : {}),
      existingPaths,
    });
  }

  const candidates = await searchCandidates({
    ctx,
    prompting,
    query: parsed.query,
    source,
    ...(requestedCategory ? { category: requestedCategory } : {}),
    includeOffensive,
  });
  if (candidates.length === 0) {
    throw new UsageError(`No skills found matching "${parsed.query}"`);
  }
  const normalizedQuery = parsed.query.trim().toLowerCase();
  const chosenCandidate =
    prompting && candidates.length > 1
      ? await promptDiscoveredCandidate(candidates)
      : (candidates.find((item) => item.name === normalizedQuery) ??
        candidates[0]!);

  const ref = resolveEffectiveRef({
    catalog,
    repo: chosenCandidate.repo,
    ...(requestedRef ? { requestedRef } : {}),
  });
  const existingPaths = repositoryPaths(catalog, chosenCandidate.repo);
  let resolvedPath = chosenCandidate.path;
  if (resolvedPath === undefined) {
    const [located] = await locateSkillsInRepo({
      cache,
      repo: chosenCandidate.repo,
      ...(ref ? { ref } : {}),
      expectedSkillName: chosenCandidate.name,
      existingPaths,
    });
    if (!located) {
      throw new SourceError(
        `Skill "${chosenCandidate.name}" was not found in ${chosenCandidate.repo}`,
      );
    }
    resolvedPath = located.path;
  }
  const effectiveCategory = requestedCategory ?? chosenCandidate.category;
  return inspectDiscoveredSkill({
    cache,
    repo: chosenCandidate.repo,
    path: resolvedPath,
    ...(ref ? { ref } : {}),
    expectedName: chosenCandidate.name,
    ...(effectiveCategory ? { category: effectiveCategory } : {}),
    existingPaths,
  });
}

function printInspectedSkill(
  ctx: Context,
  skill: ResolvedDiscoveredSkill,
): void {
  const refSuffix = skill.ref ? ` @ ${skill.ref}` : '';
  ctx.print(`Skill: ${skill.name}`);
  ctx.print(
    `Source: ${skill.repo} (${skill.path}${refSuffix}, commit ${skill.commit.slice(0, 12)})`,
  );
  if (skill.license) {
    ctx.print(`License: ${skill.license}`);
  }
  ctx.print(`Description: ${skill.description}`);
  for (const warning of skill.report.warnings) {
    ctx.print(`${WARN_LABEL}  ${skill.name}: ${warning}`);
  }
  for (const risk of skill.risks) {
    ctx.print(`${RISK_LABEL}  ${skill.name} (${risk.file}): ${risk.detail}`);
  }
}

async function writeCatalogEntry(
  file: string,
  entry: CatalogEntry,
): Promise<void> {
  try {
    await appendCatalogEntries(file, [entry]);
  } catch (error) {
    if (!isSystemError(error)) throw error;
    throw new CatalogError(
      `Could not update ${file} (${fsErrorReason(error) ?? error.message}), so ${entry.name} was not added.`,
      { cause: error },
    );
  }
}

interface RestoreAddedCatalogParams {
  ctx: Context;
  file: string;
  original: string | null;
  entry: CatalogEntry;
  location: Location;
}

async function restoreAddedCatalog({
  ctx,
  file,
  original,
  entry,
  location,
}: RestoreAddedCatalogParams): Promise<void> {
  let recorded: ReadonlySet<string>;
  try {
    const manifest = await readLocationManifest(ctx, false, location);
    recorded = new Set(manifest?.skills ?? []);
  } catch {
    return;
  }
  if (recorded.has(entry.name)) return;
  if (original === null) await removePath(file);
  else await writeTextAtomic({ path: file, content: original });
}

interface InstallAddedSkillParams {
  ctx: Context;
  prompting: boolean;
  skillLibrary: SkillLibrary;
  entry: CatalogEntry;
  inspected: ResolvedDiscoveredSkill;
  catalogFile: string;
  requestedScope?: Scope;
  projectDir?: string;
  requestedTools?: ToolId[];
  yes: boolean;
  dryRun: boolean;
}

async function installAddedSkill({
  ctx,
  prompting,
  skillLibrary,
  entry,
  inspected,
  catalogFile,
  requestedScope,
  projectDir,
  requestedTools,
  yes,
  dryRun,
}: InstallAddedSkillParams): Promise<number> {
  const scope = requestedScope ?? (prompting ? await promptScope() : 'global');
  const location = await resolveLocation({
    ctx,
    scope,
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  const previous = await readLocationManifest(ctx, prompting, location);
  const library = await loadLibrary(ctx);
  const tools =
    requestedTools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  if (tools.length === 0) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  const baseBlocks = previous
    ? dropUnavailableBlocks({
        ctx,
        prompting,
        library,
        ids: previous.blocks,
        scope,
      })
    : defaultBlockIds(library, scope);
  const { ids: blocks } = withRequirements(library, baseBlocks);
  const variables = await resolveVariables({
    ctx,
    prompting,
    library,
    blocks,
    location,
    recorded: previous?.variables ?? {},
  });
  const priorSkills = previous
    ? dropUnknownSkills({
        ctx,
        prompting,
        library: skillLibrary,
        names: previous.skills,
      })
    : [];
  const skills = [...new Set([...priorSkills, entry.name])];
  const { sources: skillSources, problems } = await resolveSkillSources({
    library: skillLibrary,
    names: priorSkills,
    cache: sourceCache(ctx),
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
  skillSources.set(entry.name, {
    dir: inspected.dir,
    record: {
      type: 'catalog',
      repo: entry.repo,
      path: entry.path,
      ...(entry.ref ? { ref: entry.ref } : {}),
      commit: inspected.commit,
    },
    linkable: false,
  });

  const preset = previous
    ? dropUnknownPreset({
        ctx,
        prompting,
        preset: previous.options.preset,
      })
    : undefined;
  const plan = await buildPlan({
    scope,
    selection: {
      tools,
      blocks,
      skills,
      variables,
      linkCommand: previous?.options.linkCommand ?? false,
      keepLocal:
        (previous?.options.keepLocal ?? false) &&
        location.project?.git !== undefined,
      skillMode: previous?.options.skillMode ?? DEFAULT_SKILL_MODE,
      ...(preset !== undefined ? { preset } : {}),
      ...(previous?.options.style !== undefined
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

  let catalogBefore: string | null | undefined;
  const writeCatalog = async () => {
    const original = await readTextIfExists(catalogFile);
    await writeCatalogEntry(catalogFile, entry);
    catalogBefore = original;
  };

  let result;
  try {
    result = await confirmAndApply(ctx, plan, {
      yes,
      dryRun,
      beforeApply: writeCatalog,
    });
  } catch (error) {
    if (catalogBefore !== undefined) {
      await restoreAddedCatalog({
        ctx,
        file: catalogFile,
        original: catalogBefore,
        entry,
        location,
      });
    }
    throw error;
  }
  if (result.applied) {
    notify({
      ctx,
      prompting,
      message: `Added to catalog.yaml: ${entry.name}`,
    });
  }
  return result.code;
}

export async function runAdd(
  ctx: Context,
  {
    target: rawTarget,
    source = 'all',
    category: requestedCategory,
    ref: requestedRef,
    includeOffensive = false,
    install = false,
    scope: requestedScope,
    projectDir,
    tools: requestedTools,
    yes,
    dryRun,
  }: AddOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const targetInput =
    rawTarget && rawTarget.trim() !== ''
      ? rawTarget.trim()
      : prompting
        ? await promptAddQuery()
        : undefined;
  if (!targetInput) {
    throw new UsageError(
      'Pass a search query, owner/repo[@skill], or GitHub URL to add.',
    );
  }

  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const inspected = await resolveTargetSkill({
    ctx,
    prompting,
    skillLibrary,
    rawTarget: targetInput,
    source,
    ...(requestedCategory ? { requestedCategory } : {}),
    ...(requestedRef ? { requestedRef } : {}),
    includeOffensive,
  });

  const existingLocal = skillLibrary.skills.find(
    (skill) => skill.name === inspected.name && skill.origin.type === 'local',
  );
  if (existingLocal && existingLocal.origin.type === 'local') {
    throw new CatalogError(
      `${inspected.name} already exists as a first-party skill in ${existingLocal.origin.path}`,
    );
  }

  const entry: CatalogEntry = {
    name: inspected.name,
    repo: inspected.repo,
    path: inspected.path,
    ...(inspected.ref ? { ref: inspected.ref } : {}),
    category: inspected.category ?? DEFAULT_ADD_CATEGORY,
    scopes: ['global', 'project'],
    defaults: [],
  };
  const file = catalogPath(ctx.repoRoot);
  const updatedCatalog = extendCatalog({
    catalog: skillLibrary.catalog,
    entries: [entry],
    file,
  });
  const extendedLibrary: SkillLibrary = {
    catalog: updatedCatalog,
    skills: [
      ...skillLibrary.skills,
      {
        name: entry.name,
        group: updatedCatalog.categories[entry.category] ?? entry.category,
        scopes: entry.scopes,
        defaults: entry.defaults,
        origin: { type: 'catalog', entry },
      },
    ],
  };

  printInspectedSkill(ctx, inspected);

  const shouldInstall =
    install || requestedScope !== undefined || requestedTools !== undefined;
  if (shouldInstall) {
    return installAddedSkill({
      ctx,
      prompting,
      skillLibrary: extendedLibrary,
      entry,
      inspected,
      catalogFile: file,
      ...(requestedScope ? { requestedScope } : {}),
      ...(projectDir !== undefined ? { projectDir } : {}),
      ...(requestedTools ? { requestedTools } : {}),
      yes,
      dryRun,
    });
  }

  ctx.print(`update  catalog.yaml (+${entry.name})`);
  if (dryRun) {
    notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
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

  await writeCatalogEntry(file, entry);
  notify({
    ctx,
    prompting,
    message: `Added to catalog.yaml: ${entry.name}`,
  });
  return 0;
}
