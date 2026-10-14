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
  mergeCandidateMetadata,
  searchCandidates,
  type SearchCandidatesParams,
} from './search.ts';
import { AWESOME_SKILLS_REPO } from './search-awesome.ts';
import type { DiscoveryCandidate } from './search-skills-sh.ts';
import {
  type DiscoverSource,
  type ParsedSkillTarget,
  parseSkillTarget,
  resolveGithubPathTarget,
} from './target.ts';

export {
  mergeCandidateMetadata,
  searchCandidates,
  type SearchCandidatesParams,
};

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

interface WithCheckoutSnapshotParams<T> {
  cache: SourceCache;
  repo: string;
  initialSnapshot?: SourceCheckoutSnapshot;
  action: () => Promise<T>;
}

async function withCheckoutSnapshot<T>({
  cache,
  repo,
  initialSnapshot,
  action,
}: WithCheckoutSnapshotParams<T>): Promise<{
  result: T;
  checkoutSnapshot: SourceCheckoutSnapshot;
}> {
  const checkoutSnapshot =
    initialSnapshot ?? (await snapshotSourceCheckout(cache, repo));

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
    ref: parsed.ref || undefined,
    path: parsed.path,
    rawSegments: parsed.rawSegments || undefined,
    explicitRef: explicitRef || undefined,
  });

  const ref = resolveEffectiveRef({
    catalog,
    repo: parsed.repo,
    requestedRef: requestedRef || undefined,
    urlRef: resolvedUrl.ref || undefined,
    urlIsDefaultBranch: resolvedUrl.isDefaultBranch,
  });

  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: parsed.repo,
    action: () =>
      inspectDiscoveredSkill({
        cache,
        repo: parsed.repo,
        path: resolvedUrl.path,
        ref: ref || undefined,
        category: requestedCategory || undefined,
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
    requestedRef: requestedRef || undefined,
  });
  const existingPaths = repositoryPaths(catalog, parsed.repo);

  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: parsed.repo,
    action: async () => {
      const [located] = await locateSkillsInRepo({
        cache,
        repo: parsed.repo,
        ref: ref || undefined,
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
        ref: ref || undefined,
        expectedName: parsed.skillName,
        category: requestedCategory || undefined,
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
    requestedRef: requestedRef || undefined,
  });
  const existingPaths = repositoryPaths(catalog, parsed.repo);

  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: parsed.repo,
    action: async () => {
      const locations = await locateSkillsInRepo({
        cache,
        repo: parsed.repo,
        ref: ref || undefined,
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
        ref: ref || undefined,
        expectedName: chosen.name,
        category: requestedCategory || undefined,
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
  const awesomeSnapshot =
    source === 'skills-sh'
      ? undefined
      : await snapshotSourceCheckout(cache, AWESOME_SKILLS_REPO);

  let chosenCandidate: DiscoveryCandidate;
  try {
    const candidates = await searchCandidates({
      cache,
      catalog,
      query,
      source,
      category: requestedCategory,
      includeOffensive,
      skillsShUrl,
      fetchFn,
      onWarn,
    });

    if (candidates.length === 0) {
      throw new UsageError(`No skills found matching "${query}"`);
    }

    const normalizedQuery = query.trim().toLowerCase();
    chosenCandidate =
      prompting && candidates.length > 1
        ? await chooseCandidate(candidates)
        : (candidates.find((item) => item.name === normalizedQuery) ??
          candidates[0]!);
  } catch (error) {
    if (awesomeSnapshot) {
      await restoreSourceCheckout(cache, awesomeSnapshot);
    }

    throw error;
  }

  if (awesomeSnapshot && chosenCandidate.repo !== AWESOME_SKILLS_REPO) {
    await restoreSourceCheckout(cache, awesomeSnapshot);
  }

  const ref = resolveEffectiveRef({
    catalog,
    repo: chosenCandidate.repo,
    requestedRef,
  });
  const existingPaths = repositoryPaths(catalog, chosenCandidate.repo);
  const initialSnapshot =
    chosenCandidate.repo === AWESOME_SKILLS_REPO ? awesomeSnapshot : undefined;

  const { result: inspected, checkoutSnapshot } = await withCheckoutSnapshot({
    cache,
    repo: chosenCandidate.repo,
    initialSnapshot,
    action: async () => {
      let resolvedPath = chosenCandidate.path;

      if (resolvedPath === undefined) {
        const [located] = await locateSkillsInRepo({
          cache,
          repo: chosenCandidate.repo,
          ref,
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
        ref,
        expectedName: chosenCandidate.name,
        category: effectiveCategory,
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
      requestedRef,
      requestedCategory,
    });
  }

  if (parsed.kind === 'repo-skill') {
    return resolveRepoSkillTarget({
      cache,
      catalog,
      parsed,
      requestedRef,
      requestedCategory,
    });
  }

  if (parsed.kind === 'repo') {
    return resolveRepoTarget({
      cache,
      catalog,
      parsed,
      requestedRef,
      requestedCategory,
      prompting,
      chooseLocation,
    });
  }

  return resolveQueryTarget({
    cache,
    catalog,
    query: parsed.query,
    source,
    requestedRef,
    requestedCategory,
    includeOffensive,
    prompting,
    skillsShUrl,
    fetchFn,
    onWarn,
    chooseCandidate,
  });
}
