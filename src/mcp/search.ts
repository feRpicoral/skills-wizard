import { z } from 'zod';

import { resolveMcpRegistryUrl } from '../env.ts';
import { McpError } from '../errors.ts';
import { readBoundedResponseText } from '../http.ts';
import {
  deriveShortServerName,
  disambiguateShortServerName,
  type McpSearchCandidate,
  type RegistryServerInner,
  registryServerInnerSchema,
  toCandidate,
} from './registry-candidate.ts';

export {
  deriveShortServerName,
  disambiguateShortServerName,
  type McpSearchCandidate,
};

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 10;
const MIN_UPSTREAM_LIMIT = 30;
const MAX_UPSTREAM_LIMIT = 100;

const registryMetaEntrySchema = z
  .looseObject({ isLatest: z.boolean().optional() })
  .or(z.unknown());

const registryMetaSchema = z.record(z.string(), registryMetaEntrySchema);

const registryServerWithMetaSchema = registryServerInnerSchema.extend({
  isLatest: z.boolean().optional(),
  _meta: registryMetaSchema.optional(),
});

const registryItemWrapperSchema = z.looseObject({
  server: registryServerWithMetaSchema.optional(),
  isLatest: z.boolean().optional(),
  _meta: registryMetaSchema.optional(),
});

const registryEnvelopeSchema = z.looseObject({
  servers: z.array(z.unknown()),
});

export interface SearchMcpRegistryParams {
  query: string;
  official?: boolean;
  limit?: number;
  baseUrl?: string | ((options?: { official?: boolean }) => string);
  fetchFn?: typeof globalThis.fetch;
}

interface ExtractedRegistryServer {
  inner: RegistryServerInner;
  isLatest: boolean;
}

function hasMetaLatest(
  meta: z.infer<typeof registryMetaSchema> | undefined,
): boolean {
  if (!meta) return false;
  for (const entry of Object.values(meta)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'isLatest' in entry &&
      entry.isLatest === true
    ) {
      return true;
    }
  }
  return false;
}

function extractInnerServer(rawItem: unknown): ExtractedRegistryServer | null {
  const wrapperResult = registryItemWrapperSchema.safeParse(rawItem);
  if (wrapperResult.success && wrapperResult.data.server !== undefined) {
    const { server, isLatest, _meta } = wrapperResult.data;
    return {
      inner: server,
      isLatest:
        isLatest === true ||
        server.isLatest === true ||
        hasMetaLatest(_meta) ||
        hasMetaLatest(server._meta),
    };
  }
  const directResult = registryServerWithMetaSchema.safeParse(rawItem);
  if (!directResult.success) return null;
  return {
    inner: directResult.data,
    isLatest:
      directResult.data.isLatest === true ||
      hasMetaLatest(directResult.data._meta),
  };
}

interface BuildRegistrySearchUrlParams {
  baseUrl: string | ((options?: { official?: boolean }) => string) | undefined;
  official: boolean;
  query: string;
  limit: number;
}

function buildRegistrySearchUrl({
  baseUrl,
  official,
  query,
  limit,
}: BuildRegistrySearchUrlParams): string {
  const raw =
    typeof baseUrl === 'function'
      ? baseUrl({ official })
      : typeof baseUrl === 'string' && baseUrl.trim()
        ? baseUrl.trim()
        : resolveMcpRegistryUrl({ official, env: {} });
  const trimmed = raw.replace(/\/+$/, '');
  const upstreamLimit = Math.min(
    Math.max(limit * 3, MIN_UPSTREAM_LIMIT),
    MAX_UPSTREAM_LIMIT,
  );
  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/v0.1/servers';
    }
    url.searchParams.set('search', query);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(upstreamLimit));
    return url.toString();
  } catch {
    const params = new URLSearchParams({
      search: query,
      version: 'latest',
      limit: String(upstreamLimit),
    });
    return `${trimmed}?${params.toString()}`;
  }
}

/**
 * Queries an MCP registry v0.1 endpoint, groups results by full server name
 * preferring `isLatest` versions, and converts supported `npm`, `pypi`, `http`,
 * and `sse` entries into validated `McpSearchCandidate` definitions.
 *
 * @throws {McpError} If the HTTP request fails, returns a non-2xx status,
 *   exceeds `MAX_RESPONSE_BYTES`, or returns an invalid payload.
 */
export async function searchMcpRegistry({
  query,
  official = false,
  limit = DEFAULT_LIMIT,
  baseUrl,
  fetchFn = globalThis.fetch,
}: SearchMcpRegistryParams): Promise<McpSearchCandidate[]> {
  const endpoint = buildRegistrySearchUrl({ baseUrl, official, query, limit });

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new McpError(
      `Could not reach MCP registry (${endpoint}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new McpError(
      `MCP registry search returned HTTP ${response.status} (${endpoint})`,
    );
  }

  let text: string;
  try {
    text = await readBoundedResponseText({
      response,
      maxBytes: MAX_RESPONSE_BYTES,
      onOverflow: () =>
        new McpError(
          `MCP registry response exceeded ${MAX_RESPONSE_BYTES} bytes`,
        ),
    });
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(
      `MCP registry response failed (${endpoint}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(text);
  } catch (error) {
    throw new McpError('MCP registry response is not valid JSON', {
      cause: error,
    });
  }

  const envelope = registryEnvelopeSchema.safeParse(rawJson);
  if (!envelope.success) {
    throw new McpError(
      `Unexpected MCP registry response: ${z.prettifyError(envelope.error)}`,
    );
  }

  const groupedByFullName = new Map<string, ExtractedRegistryServer[]>();
  for (const rawItem of envelope.data.servers) {
    const extracted = extractInnerServer(rawItem);
    if (!extracted) continue;
    const existing = groupedByFullName.get(extracted.inner.name) ?? [];
    existing.push(extracted);
    groupedByFullName.set(extracted.inner.name, existing);
  }

  const usedNames = new Set<string>();
  const candidates: McpSearchCandidate[] = [];
  for (const [fullName, versions] of groupedByFullName) {
    const baseName = deriveShortServerName(fullName);
    if (!baseName) continue;
    const shortName = disambiguateShortServerName({
      registryName: fullName,
      baseName,
      usedNames,
    });
    if (!shortName) continue;

    const ordered = [...versions].sort(
      (a, b) => Number(b.isLatest) - Number(a.isLatest),
    );
    let matched: McpSearchCandidate | null = null;
    for (const entry of ordered) {
      try {
        matched = toCandidate({ inner: entry.inner, shortName });
      } catch {
        continue;
      }
      if (matched) break;
    }
    if (!matched) continue;
    usedNames.add(matched.server.name);
    candidates.push(matched);
    if (candidates.length >= limit) break;
  }

  return candidates;
}
