import { z } from 'zod';

import { DEFAULT_SKILLS_SH_URL } from '../../env.ts';
import { SourceError } from '../../errors.ts';
import { readBoundedResponseText } from '../../http.ts';
import {
  isRepository,
  isRepositoryPath,
  WHOLE_REPOSITORY,
} from '../catalog.ts';
import { isSkillName } from '../validate.ts';

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 20;

export interface DiscoveryCandidate {
  sourceType: 'skills-sh' | 'awesome';
  name: string;
  repo: string;
  path?: string;
  description?: string;
  category?: string;
  installs?: number;
  risk?: string;
  tags?: string[];
  upstreamRepo?: string;
}

const skillsShItemSchema = z.object({
  id: z.string(),
  skillId: z.string().min(1),
  name: z.string().min(1),
  installs: z.number().int().nonnegative(),
  source: z.string().min(1),
});

const skillsShEnvelopeSchema = z.object({
  skills: z.array(z.unknown()),
});

function resolveSkillsShName(
  item: z.infer<typeof skillsShItemSchema>,
): string | null {
  if (isSkillName(item.skillId)) return item.skillId;
  if (isSkillName(item.name)) return item.name;

  return null;
}

export interface SearchSkillsShParams {
  query: string;
  baseUrl?: string;
  limit?: number;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Queries the skills.sh `/api/search` endpoint and returns validated skill
 * candidates sorted by install count descending.
 *
 * Uses `URL` and `URLSearchParams` to construct the endpoint, enforces a
 * response body size cap via {@link readBoundedResponseText}, and filters out
 * malformed or duplicate items.
 *
 * @throws {SourceError} If the HTTP request fails, times out, exceeds the size cap, or returns invalid JSON.
 */
export async function searchSkillsSh({
  query,
  baseUrl = DEFAULT_SKILLS_SH_URL,
  limit = DEFAULT_SEARCH_LIMIT,
  fetchFn = globalThis.fetch,
}: SearchSkillsShParams): Promise<DiscoveryCandidate[]> {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('api/search', normalizedBase);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const endpoint = url.toString();

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SourceError(`skills.sh search failed (${endpoint}): ${detail}`);
  }

  if (!response.ok) {
    throw new SourceError(
      `skills.sh search failed (${endpoint}): HTTP ${response.status}`,
    );
  }

  let text: string;
  try {
    text = await readBoundedResponseText({
      response,
      maxBytes: MAX_SEARCH_RESPONSE_BYTES,
      exceededMessage: `skills.sh search response exceeded ${MAX_SEARCH_RESPONSE_BYTES} bytes (${endpoint})`,
    });
  } catch (error) {
    if (error instanceof SourceError) throw error;

    const detail = error instanceof Error ? error.message : String(error);
    throw new SourceError(
      `skills.sh search response failed (${endpoint}): ${detail}`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new SourceError(
      `skills.sh search returned invalid JSON (${endpoint})`,
    );
  }

  const envelope = skillsShEnvelopeSchema.safeParse(parsedJson);

  if (!envelope.success) {
    throw new SourceError(
      `skills.sh search response did not match expected schema (${endpoint})`,
    );
  }

  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];

  for (const rawItem of envelope.data.skills) {
    const itemResult = skillsShItemSchema.safeParse(rawItem);
    if (!itemResult.success) continue;

    const item = itemResult.data;
    const sourceSegments = item.source.split('/').filter(Boolean);
    if (sourceSegments.length < 2) continue;

    const repo = `${sourceSegments[0]}/${sourceSegments[1]}`;
    const subpath =
      sourceSegments.length > 2 ? sourceSegments.slice(2).join('/') : undefined;

    if (
      !isRepository(repo) ||
      (subpath !== undefined &&
        subpath !== WHOLE_REPOSITORY &&
        !isRepositoryPath(subpath))
    ) {
      continue;
    }

    const candidateName = resolveSkillsShName(item);
    if (!candidateName) continue;

    const dedupeKey = `${repo}@${candidateName}`;
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    candidates.push({
      sourceType: 'skills-sh',
      name: candidateName,
      repo,
      ...(subpath ? { path: subpath } : {}),
      installs: item.installs,
    });
  }

  return candidates.sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
}
