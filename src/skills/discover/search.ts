import { SourceError } from '../../errors.ts';
import { type Catalog, repositoryPaths } from '../catalog.ts';
import type { SourceCache } from '../sources.ts';
import {
  AWESOME_SKILLS_REPO,
  isOffensiveCandidate,
  searchAwesomeIndex,
  searchAwesomeIndexWithAll,
} from './search-awesome.ts';
import { type DiscoveryCandidate, searchSkillsSh } from './search-skills-sh.ts';
import type { DiscoverSource } from './target.ts';

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
    searchAwesomeIndexWithAll({
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

  const awesomeMatched =
    awesomeOutcome.status === 'fulfilled' ? awesomeOutcome.value.matched : [];
  const awesomeAll =
    awesomeOutcome.status === 'fulfilled' ? awesomeOutcome.value.all : [];
  const awesomeByKey = new Map<string, DiscoveryCandidate>();
  const awesomeByName = new Map<string, DiscoveryCandidate | null>();
  for (const item of awesomeAll) {
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
    ...awesomeMatched,
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
