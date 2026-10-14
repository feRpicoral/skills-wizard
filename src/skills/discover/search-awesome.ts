import { join, posix } from 'node:path';

import { z } from 'zod';

import { SourceError } from '../../errors.ts';
import { lstatIfExists, readTextIfExists } from '../../install/fs.ts';
import { isRepository, isRepositoryPath } from '../catalog.ts';
import { cachedSourceRef, ensureSource, type SourceCache } from '../sources.ts';
import { isSkillName } from '../validate.ts';
import type { DiscoveryCandidate } from './search-skills-sh.ts';

export const AWESOME_SKILLS_REPO = 'sickn33/agentic-awesome-skills';
export const AWESOME_INDEX_FILE = 'skills_index.json';

const awesomeItemSchema = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1),
  category: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  risk: z.string().optional(),
  source: z.string().optional(),
  date_added: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const awesomeIndexSchema = z.union([
  z.array(z.unknown()),
  z
    .looseObject({ skills: z.array(z.unknown()) })
    .transform((obj) => obj.skills),
]);

type AwesomeItem = z.infer<typeof awesomeItemSchema>;

function isOffensiveEntry(entry: AwesomeItem): boolean {
  return (
    entry.category.toLowerCase() === 'offensive' ||
    entry.risk?.toLowerCase() === 'offensive'
  );
}

export function isOffensiveCandidate(candidate: DiscoveryCandidate): boolean {
  return (
    candidate.category?.toLowerCase() === 'offensive' ||
    candidate.risk?.toLowerCase() === 'offensive'
  );
}

function resolveAwesomeSkillName(entry: AwesomeItem): string | undefined {
  if (isSkillName(entry.id)) return entry.id;
  if (isSkillName(entry.name)) return entry.name;
  const folder = posix.basename(entry.path);
  return isSkillName(folder) ? folder : undefined;
}

interface MatchAwesomeEntryParams {
  entry: AwesomeItem;
  skillName: string;
  terms: readonly string[];
}

function matchesAwesomeQuery({
  entry,
  skillName,
  terms,
}: MatchAwesomeEntryParams): boolean {
  if (terms.length === 0) return true;
  const haystacks = [
    skillName.toLowerCase(),
    entry.id.toLowerCase(),
    entry.name.toLowerCase(),
    entry.description.toLowerCase(),
    entry.category.toLowerCase(),
    ...(entry.tags ?? []).map((tag) => tag.toLowerCase()),
  ];
  return terms.every((term) =>
    haystacks.some((haystack) => haystack.includes(term)),
  );
}

interface ScoreAwesomeCandidateParams {
  candidate: DiscoveryCandidate;
  normalizedQuery: string;
}

function scoreAwesomeCandidate({
  candidate,
  normalizedQuery,
}: ScoreAwesomeCandidateParams): number {
  if (!normalizedQuery) return 2;
  const name = candidate.name.toLowerCase();
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  return 2;
}

export interface SearchAwesomeIndexParams {
  cache: SourceCache;
  query?: string;
  category?: string;
  includeOffensive?: boolean;
  repo?: string;
  ref?: string;
  existingPaths?: readonly string[];
}

/**
 * Searches `skills_index.json` in `sickn33/agentic-awesome-skills` (via sparse
 * git checkout), filtering by query terms, optional category, and offensive
 * risk status.
 */
export async function searchAwesomeIndex({
  cache,
  query,
  category,
  includeOffensive = false,
  repo = AWESOME_SKILLS_REPO,
  ref,
  existingPaths = [],
}: SearchAwesomeIndexParams): Promise<DiscoveryCandidate[]> {
  const effectiveRef = ref ?? (await cachedSourceRef(cache, repo));
  const root = await ensureSource(cache, {
    repo,
    ...(effectiveRef ? { ref: effectiveRef } : {}),
    paths: existingPaths,
  });
  const indexFile = join(root, AWESOME_INDEX_FILE);
  const indexStat = await lstatIfExists(indexFile);
  if (!indexStat?.isFile()) {
    throw new SourceError(`${repo} does not contain ${AWESOME_INDEX_FILE}`);
  }
  const rawContent = await readTextIfExists(indexFile);
  if (rawContent === null) {
    throw new SourceError(`${repo} does not contain ${AWESOME_INDEX_FILE}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (error) {
    throw new SourceError(`${repo}/${AWESOME_INDEX_FILE} is not valid JSON`, {
      cause: error,
    });
  }
  const validated = awesomeIndexSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new SourceError(
      `${repo}/${AWESOME_INDEX_FILE} is invalid: ${z.prettifyError(validated.error)}`,
    );
  }

  const normalizedQuery = query?.trim().toLowerCase() ?? '';
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const normalizedCategory = category?.trim().toLowerCase();

  const candidates: DiscoveryCandidate[] = [];
  for (const rawEntry of validated.data) {
    const parsedEntry = awesomeItemSchema.safeParse(rawEntry);
    if (!parsedEntry.success) continue;
    const entry = parsedEntry.data;
    if (!isRepositoryPath(entry.path)) continue;
    const skillName = resolveAwesomeSkillName(entry);
    if (!skillName) continue;
    if (!includeOffensive && isOffensiveEntry(entry)) continue;
    if (
      normalizedCategory &&
      entry.category.toLowerCase() !== normalizedCategory
    ) {
      continue;
    }
    if (!matchesAwesomeQuery({ entry, skillName, terms })) continue;
    candidates.push({
      sourceType: 'awesome',
      name: skillName,
      repo,
      ...(entry.source && isRepository(entry.source)
        ? { upstreamRepo: entry.source }
        : {}),
      path: entry.path,
      description: entry.description,
      category: entry.category,
      ...(entry.risk ? { risk: entry.risk } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
    });
  }

  return candidates.sort(
    (a, b) =>
      scoreAwesomeCandidate({ candidate: a, normalizedQuery }) -
        scoreAwesomeCandidate({ candidate: b, normalizedQuery }) ||
      a.name.localeCompare(b.name),
  );
}
