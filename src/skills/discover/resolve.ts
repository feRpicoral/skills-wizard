import { CatalogError, SourceError, UsageError } from '../../errors.ts';
import { type Catalog, repositoryPaths } from '../catalog.ts';
import type { SkillLibrary } from '../library.ts';
import {
  restoreSourceCheckout,
  snapshotSourceCheckout,
  type SourceCache,
  type SourceCheckoutSnapshot,
} from '../sources.ts';
import {
  inspectDiscoveredSkill,
  locateSkillsInRepo,
  type RepoSkillLocation,
  type ResolvedDiscoveredSkill,
} from './inspect.ts';
import {
  AWESOME_SKILLS_REPO,
  isOffensiveCandidate,
  searchAwesomeIndex,
} from './search-awesome.ts';
import { type DiscoveryCandidate, searchSkillsSh } from './search-skills-sh.ts';
import {
  type DiscoverSource,
  type ParsedSkillTarget,
  parseSkillTarget,
  resolveGithubPathTarget,
} from './target.ts';

export interface ResolveEffectiveRefParams {
  catalog: Catalog;
  repo: string;
  requestedRef?: string;
  urlRef?: string;
  urlIsDefaultBranch?: boolean;
}

export function resolveEffectiveRef({
  catalog,
  repo,
  requestedRef,
  urlRef,
  urlIsDefaultBranch = false,
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
    if (
      existing.ref === undefined &&
      requestedRef === undefined &&
      urlIsDefaultBranch
    ) {
      return undefined;
    }
    if (explicitRef !== undefined && explicitRef !== existing.ref) {
      throw new CatalogError(
        `Every skill from ${repo} in catalog.yaml must use the same ref (${existing.ref ?? 'default branch'})`,
      );
    }
    return existing.ref;
  }
  return explicitRef;
}

interface MergeCandidateMetadataParams {
  primary: DiscoveryCandidate;
  enrichment: DiscoveryCandidate | undefined;
}

export function mergeCandidateMetadata({
  primary,
  enrichment,
}: MergeCandidateMetadataParams): DiscoveryCandidate {
  if (!enrichment || primary === enrichment) return primary;
  const sameRepo = primary.repo === enrichment.repo;
  const path = primary.path ?? (sameRepo ? enrichment.path : undefined);
  const description = primary.description ?? enrichment.description;
  const category = primary.category ?? enrichment.category;
  const risk = primary.risk ?? enrichment.risk;
  const tags = primary.tags ?? enrichment.tags;
  return {
    ...primary,
    ...(path !== undefined ? { path } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(risk !== undefined ? { risk } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

export interface SearchCandidatesParams {
  cache: SourceCache;
  catalog: Catalog;
  query: string;
  source: DiscoverSource;
  category?: string;
  includeOffensive: boolean;
  skillsShUrl?: string | (() => string);
  fetchFn?: typeof globalThis.fetch;
  onWarn?: (message: string) => void;
}

export async function searchCandidates({
  cache,
  catalog,
  query,
  source,
  category,
  includeOffensive,
  skillsShUrl,
  fetchFn,
  onWarn,
}: SearchCandidatesParams): Promise<DiscoveryCandidate[]> {
  const awesomeExisting = catalog.skills.find(
    (entry) => entry.repo === AWESOME_SKILLS_REPO,
  );
  const awesomePaths = repositoryPaths(catalog, AWESOME_SKILLS_REPO);
  if (source === 'awesome') {
    return searchAwesomeIndex({
      cache,
      query,
      ...(category ? { category } : {}),
      includeOffensive,
      ...(awesomeExisting?.ref ? { ref: awesomeExisting.ref } : {}),
      existingPaths: awesomePaths,
    });
  }

  const baseUrl =
    typeof skillsShUrl === 'function' ? skillsShUrl() : skillsShUrl;

  if (source === 'skills-sh') {
    return searchSkillsSh({
      query,
      ...(baseUrl ? { baseUrl } : {}),
      ...(fetchFn ? { fetchFn } : {}),
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
      includeOffensive: true,
      ...(awesomeExisting?.ref ? { ref: awesomeExisting.ref } : {}),
      existingPaths: awesomePaths,
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
    onWarn?.(reason.message);
  }
  if (awesomeOutcome.status === 'rejected') {
    const reason = awesomeOutcome.reason as unknown;
    if (!(reason instanceof SourceError)) throw reason;
    onWarn?.(reason.message);
  }

  const awesomeItems =
    awesomeOutcome.status === 'fulfilled' ? awesomeOutcome.value : [];
  const awesomeByKey = new Map<string, DiscoveryCandidate>();
  const awesomeByName = new Map<string, DiscoveryCandidate | null>();
  for (const item of awesomeItems) {
    awesomeByKey.set(`${item.repo}@${item.name}`, item);
    if (item.upstreamRepo) {
      awesomeByKey.set(`${item.upstreamRepo}@${item.name}`, item);
    }
    if (awesomeByName.has(item.name)) {
      awesomeByName.set(item.name, null);
    } else {
      awesomeByName.set(item.name, item);
    }
  }

  const combined = [
    ...(skillsShOutcome.status === 'fulfilled' ? skillsShOutcome.value : []),
    ...awesomeItems,
  ];
  const normalizedCategory = category?.trim().toLowerCase();
  const seen = new Set<string>();
  const deduplicated: DiscoveryCandidate[] = [];
  for (const item of combined) {
    const key = `${item.repo}@${item.name}`;
    if (seen.has(key)) continue;
    const enrichment =
      awesomeByKey.get(key) ?? awesomeByName.get(item.name) ?? undefined;
    const merged = mergeCandidateMetadata({
      primary: item,
      enrichment,
    });
    if (!includeOffensive && isOffensiveCandidate(merged)) {
      seen.add(key);
      continue;
    }
    if (
      normalizedCategory &&
      merged.category?.toLowerCase() !== normalizedCategory
    ) {
      seen.add(key);
      continue;
    }
    seen.add(key);
    deduplicated.push(merged);
  }
  return deduplicated;
}

interface WithCheckoutSnapshotParams<T> {
  cache: SourceCache;
  repo: string;
  action: () => Promise<T>;
}

async function withCheckoutSnapshot<T>({
  cache,
  repo,
  action,
}: WithCheckoutSnapshotParams<T>): Promise<{
  result: T;
  checkoutSnapshot: SourceCheckoutSnapshot;
}> {
  const checkoutSnapshot = await snapshotSourceCheckout(cache, repo);
  try {
    const result = await action();
    return { result, checkoutSnapshot };
  } catch (error) {
    await restoreSourceCheckout(cache, checkoutSnapshot);
    throw error;
  }
}

export interface ResolveTargetCandidateParams {
  cache: SourceCache;
  skillLibrary: SkillLibrary;
  rawTarget: string;
  source: DiscoverSource;
  requestedCategory?: string;
  requestedRef?: string;
  includeOffensive: boolean;
  prompting: boolean;
  skillsShUrl?: string | (() => string);
  fetchFn?: typeof globalThis.fetch;
  onWarn?: (message: string) => void;
  chooseLocation: (params: {
    repo: string;
    locations: readonly RepoSkillLocation[];
  }) => Promise<RepoSkillLocation>;
  chooseCandidate: (
    candidates: readonly DiscoveryCandidate[],
  ) => Promise<DiscoveryCandidate>;
}

export interface ResolvedTargetOutcome {
  inspected: ResolvedDiscoveredSkill;
  checkoutSnapshot: SourceCheckoutSnapshot;
}

async function resolveGithubPathTargetSkill({
  cache,
  catalog,
  parsed,
  requestedRef,
  requestedCategory,
}: {
  cache: SourceCache;
  catalog: Catalog;
  parsed: Extract<ParsedSkillTarget, { kind: 'github-path' }>;
  requestedRef?: string;
  requestedCategory?: string;
}): Promise<ResolvedTargetOutcome> {
  const existing = catalog.skills.find((entry) => entry.repo === parsed.repo);
  const explicitRef = requestedRef ?? existing?.ref;
  const resolvedUrl = await resolveGithubPathTarget({
    cache,
    repo: parsed.repo,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    path: parsed.path,
    ...(parsed.rawSegments ? { rawSegments: parsed.rawSegments } : {}),
    ...(explicitRef ? { explicitRef } : {}),
  });
  const ref = resolveEffectiveRef({
    catalog,
    repo: parsed.repo,
    ...(requestedRef ? { requestedRef } : {}),
    ...(resolvedUrl.ref ? { urlRef: resolvedUrl.ref } : {}),
    ...(resolvedUrl.isDefaultBranch !== undefined
      ? { urlIsDefaultBranch: resolvedUrl.isDefaultBranch }
      : {}),
  });
  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: parsed.repo,
    action: () =>
      inspectDiscoveredSkill({
        cache,
        repo: parsed.repo,
        path: resolvedUrl.path,
        ...(ref ? { ref } : {}),
        ...(requestedCategory ? { category: requestedCategory } : {}),
        existingPaths: repositoryPaths(catalog, parsed.repo),
      }),
  });
  return { inspected, checkoutSnapshot };
}

async function resolveRepoSkillTarget({
  cache,
  catalog,
  parsed,
  requestedRef,
  requestedCategory,
}: {
  cache: SourceCache;
  catalog: Catalog;
  parsed: Extract<ParsedSkillTarget, { kind: 'repo-skill' }>;
  requestedRef?: string;
  requestedCategory?: string;
}): Promise<ResolvedTargetOutcome> {
  const ref = resolveEffectiveRef({
    catalog,
    repo: parsed.repo,
    ...(requestedRef ? { requestedRef } : {}),
  });
  const existingPaths = repositoryPaths(catalog, parsed.repo);
  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: parsed.repo,
    action: async () => {
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
    },
  });
  return { inspected, checkoutSnapshot };
}

async function resolveRepoTarget({
  cache,
  catalog,
  parsed,
  requestedRef,
  requestedCategory,
  prompting,
  chooseLocation,
}: {
  cache: SourceCache;
  catalog: Catalog;
  parsed: Extract<ParsedSkillTarget, { kind: 'repo' }>;
  requestedRef?: string;
  requestedCategory?: string;
  prompting: boolean;
  chooseLocation: (params: {
    repo: string;
    locations: readonly RepoSkillLocation[];
  }) => Promise<RepoSkillLocation>;
}): Promise<ResolvedTargetOutcome> {
  const ref = resolveEffectiveRef({
    catalog,
    repo: parsed.repo,
    ...(requestedRef ? { requestedRef } : {}),
  });
  const existingPaths = repositoryPaths(catalog, parsed.repo);
  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: parsed.repo,
    action: async () => {
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
        chosen = await chooseLocation({
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
    },
  });
  return { inspected, checkoutSnapshot };
}

async function resolveQueryTarget({
  cache,
  catalog,
  query,
  source,
  requestedRef,
  requestedCategory,
  includeOffensive,
  prompting,
  skillsShUrl,
  fetchFn,
  onWarn,
  chooseCandidate,
}: {
  cache: SourceCache;
  catalog: Catalog;
  query: string;
  source: DiscoverSource;
  requestedRef?: string;
  requestedCategory?: string;
  includeOffensive: boolean;
  prompting: boolean;
  skillsShUrl?: string | (() => string);
  fetchFn?: typeof globalThis.fetch;
  onWarn?: (message: string) => void;
  chooseCandidate: (
    candidates: readonly DiscoveryCandidate[],
  ) => Promise<DiscoveryCandidate>;
}): Promise<ResolvedTargetOutcome> {
  const candidates = await searchCandidates({
    cache,
    catalog,
    query,
    source,
    ...(requestedCategory ? { category: requestedCategory } : {}),
    includeOffensive,
    ...(skillsShUrl ? { skillsShUrl } : {}),
    ...(fetchFn ? { fetchFn } : {}),
    ...(onWarn ? { onWarn } : {}),
  });
  if (candidates.length === 0) {
    throw new UsageError(`No skills found matching "${query}"`);
  }
  const normalizedQuery = query.trim().toLowerCase();
  const chosenCandidate =
    prompting && candidates.length > 1
      ? await chooseCandidate(candidates)
      : (candidates.find((item) => item.name === normalizedQuery) ??
        candidates[0]!);

  const ref = resolveEffectiveRef({
    catalog,
    repo: chosenCandidate.repo,
    ...(requestedRef ? { requestedRef } : {}),
  });
  const existingPaths = repositoryPaths(catalog, chosenCandidate.repo);
  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: chosenCandidate.repo,
    action: async () => {
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
    },
  });
  return { inspected, checkoutSnapshot };
}

/**
 * Resolves a raw user target (`github-path`, `repo-skill`, `repo`, or `query`)
 * into a validated {@link ResolvedDiscoveredSkill} and a prior
 * {@link SourceCheckoutSnapshot} for rollback on dry-run or cancellation.
 */
export async function resolveTargetSkill({
  cache,
  skillLibrary,
  rawTarget,
  source,
  requestedCategory,
  requestedRef,
  includeOffensive,
  prompting,
  skillsShUrl,
  fetchFn,
  onWarn,
  chooseLocation,
  chooseCandidate,
}: ResolveTargetCandidateParams): Promise<ResolvedTargetOutcome> {
  const { catalog } = skillLibrary;
  const parsed = parseSkillTarget(rawTarget);

  if (parsed.kind === 'github-path') {
    return resolveGithubPathTargetSkill({
      cache,
      catalog,
      parsed,
      ...(requestedRef ? { requestedRef } : {}),
      ...(requestedCategory ? { requestedCategory } : {}),
    });
  }

  if (parsed.kind === 'repo-skill') {
    return resolveRepoSkillTarget({
      cache,
      catalog,
      parsed,
      ...(requestedRef ? { requestedRef } : {}),
      ...(requestedCategory ? { requestedCategory } : {}),
    });
  }

  if (parsed.kind === 'repo') {
    return resolveRepoTarget({
      cache,
      catalog,
      parsed,
      ...(requestedRef ? { requestedRef } : {}),
      ...(requestedCategory ? { requestedCategory } : {}),
      prompting,
      chooseLocation,
    });
  }

  return resolveQueryTarget({
    cache,
    catalog,
    query: parsed.query,
    source,
    ...(requestedRef ? { requestedRef } : {}),
    ...(requestedCategory ? { requestedCategory } : {}),
    includeOffensive,
    prompting,
    ...(skillsShUrl ? { skillsShUrl } : {}),
    ...(fetchFn ? { fetchFn } : {}),
    ...(onWarn ? { onWarn } : {}),
    chooseCandidate,
  });
}
