import { z } from 'zod';

import {
  DEFAULT_GITHUB_MCP_REGISTRY_URL,
  DEFAULT_OFFICIAL_MCP_REGISTRY_URL,
} from '../env.ts';
import { McpError } from '../errors.ts';
import {
  isEnvVarName,
  isMcpServerName,
  type McpServerDefinition,
  type McpValue,
  parseMcpCatalog,
} from './model.ts';

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 10;

const registryEnvVarSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  value: z.string().optional(),
});

const registryArgSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  default: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
});

const registryPackageSchema = z.looseObject({
  registryType: z.string().optional(),
  registry_name: z.string().optional(),
  identifier: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  runtimeHint: z.string().optional(),
  packageArguments: z.array(registryArgSchema).optional(),
  environmentVariables: z.array(registryEnvVarSchema).optional(),
});

const registryHeaderSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  value: z.string().optional(),
});

const registryRemoteSchema = z.looseObject({
  type: z.string().optional(),
  transport_type: z.string().optional(),
  url: z.string().min(1),
  headers: z.array(registryHeaderSchema).optional(),
});

const registryServerInnerSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  packages: z.array(registryPackageSchema).optional(),
  remotes: z.array(registryRemoteSchema).optional(),
});

const registryEnvelopeSchema = z.looseObject({
  servers: z.array(z.unknown()),
});

export interface McpSearchCandidate {
  name: string;
  fullName: string;
  description: string;
  transport: McpServerDefinition['transport'];
  version?: string;
  server: McpServerDefinition;
}

export interface SearchMcpRegistryParams {
  query: string;
  official?: boolean;
  limit?: number;
  baseUrl?: string | ((official?: boolean) => string);
  fetchFn?: typeof globalThis.fetch;
}

async function readBoundedText(
  response: Response,
  label: string,
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new McpError(
      `${label} response exceeded ${MAX_RESPONSE_BYTES} bytes`,
    );
  }
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new McpError(
        `${label} response exceeded ${MAX_RESPONSE_BYTES} bytes`,
      );
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new McpError(
          `${label} response exceeded ${MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

export function deriveShortServerName(registryName: string): string | null {
  const tail = registryName.split('/').at(-1) ?? registryName;
  const normalized = tail
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized || !isMcpServerName(normalized)) return null;
  return normalized;
}

interface ToSecretEnvNameParams {
  raw: string;
  fallbackPrefix: string;
}

function toSecretEnvName({
  raw,
  fallbackPrefix,
}: ToSecretEnvNameParams): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (cleaned && isEnvVarName(cleaned)) return cleaned;
  const prefix = fallbackPrefix.replace(/[^A-Za-z0-9_]+/g, '_').toUpperCase();
  const candidate = `${prefix}_${cleaned || 'SECRET'}`;
  return isEnvVarName(candidate) ? candidate : 'MCP_SECRET_TOKEN';
}

function buildPackageArgs(
  args: readonly z.infer<typeof registryArgSchema>[],
): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.isSecret) continue;
    const val = arg.value ?? arg.default;
    if (!val) continue;
    if (arg.type === 'named' && arg.name) {
      const flag = arg.name.startsWith('-') ? arg.name : `--${arg.name}`;
      out.push(flag, val);
    } else {
      out.push(val);
    }
  }
  return out;
}

function buildStdioEnv(
  vars: readonly z.infer<typeof registryEnvVarSchema>[],
  shortName: string,
): Record<string, McpValue> {
  const env: Record<string, McpValue> = {};
  for (const item of vars) {
    const key = toSecretEnvName({ raw: item.name, fallbackPrefix: shortName });
    if (!isEnvVarName(key)) continue;
    const literal = item.value ?? item.default;
    if (item.isSecret || !literal) {
      env[key] = {
        secret: key,
        ...(item.isRequired === false ? { optional: true } : {}),
      };
    } else {
      env[key] = literal;
    }
  }
  return env;
}

function buildRemoteHeaders(
  headers: readonly z.infer<typeof registryHeaderSchema>[],
  shortName: string,
): Record<string, McpValue> {
  const out: Record<string, McpValue> = {};
  for (const header of headers) {
    const literal = header.value ?? header.default;
    if (header.isSecret || !literal) {
      const defaultSecretName =
        header.name.toLowerCase() === 'authorization'
          ? `${shortName.replace(/-/g, '_').toUpperCase()}_AUTH_TOKEN`
          : toSecretEnvName({ raw: header.name, fallbackPrefix: shortName });
      out[header.name] = {
        secret: defaultSecretName,
        ...(header.isRequired === false ? { optional: true } : {}),
      };
    } else {
      out[header.name] = literal;
    }
  }
  return out;
}

function extractInnerServer(
  rawItem: unknown,
): z.infer<typeof registryServerInnerSchema> | null {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const wrapped = rawItem as { server?: unknown };
  const candidate =
    typeof wrapped.server === 'object' && wrapped.server !== null
      ? wrapped.server
      : rawItem;
  const parsed = registryServerInnerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function toCandidate(
  inner: z.infer<typeof registryServerInnerSchema>,
): McpSearchCandidate | null {
  const shortName = deriveShortServerName(inner.name);
  if (!shortName) return null;
  const description = inner.description?.trim() || `${shortName} MCP server`;

  for (const pkg of inner.packages ?? []) {
    const kind = (pkg.registryType ?? pkg.registry_name ?? '').toLowerCase();
    const hint = (pkg.runtimeHint ?? '').toLowerCase();
    const identifier = (pkg.identifier ?? pkg.name ?? '').trim();
    if (!identifier) continue;
    const version = (pkg.version ?? inner.version ?? '').trim();
    const spec =
      version && !identifier.includes('@', 1)
        ? `${identifier}@${version}`
        : identifier;
    const extraArgs = buildPackageArgs(pkg.packageArguments ?? []);
    const env = buildStdioEnv(pkg.environmentVariables ?? [], shortName);

    if (kind === 'npm' || hint === 'npx') {
      const validated = parseMcpCatalog(
        {
          servers: [
            {
              name: shortName,
              description,
              scopes: ['global', 'project'],
              defaults: [],
              transport: 'stdio',
              command: 'npx',
              args: ['-y', spec, ...extraArgs],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            },
          ],
        },
        'registry',
      );
      const server = validated.servers[0]!;
      return {
        name: server.name,
        fullName: inner.name,
        description: server.description,
        transport: server.transport,
        ...(version ? { version } : {}),
        server,
      };
    }

    if (kind === 'pypi' || hint === 'uvx') {
      const validated = parseMcpCatalog(
        {
          servers: [
            {
              name: shortName,
              description,
              scopes: ['global', 'project'],
              defaults: [],
              transport: 'stdio',
              command: 'uvx',
              args: [spec, ...extraArgs],
              ...(Object.keys(env).length > 0 ? { env } : {}),
            },
          ],
        },
        'registry',
      );
      const server = validated.servers[0]!;
      return {
        name: server.name,
        fullName: inner.name,
        description: server.description,
        transport: server.transport,
        ...(version ? { version } : {}),
        server,
      };
    }
  }

  for (const remote of inner.remotes ?? []) {
    const rawType = (remote.type ?? remote.transport_type ?? '').toLowerCase();
    const transport =
      rawType === 'sse'
        ? 'sse'
        : rawType === 'http' || rawType === 'streamable-http'
          ? 'http'
          : null;
    if (!transport) continue;
    const headers = buildRemoteHeaders(remote.headers ?? [], shortName);
    try {
      const validated = parseMcpCatalog(
        {
          servers: [
            {
              name: shortName,
              description,
              scopes: ['global', 'project'],
              defaults: [],
              transport,
              url: remote.url,
              ...(Object.keys(headers).length > 0 ? { headers } : {}),
            },
          ],
        },
        'registry',
      );
      const server = validated.servers[0]!;
      return {
        name: server.name,
        fullName: inner.name,
        description: server.description,
        transport: server.transport,
        ...(inner.version ? { version: inner.version } : {}),
        server,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function resolveRegistryEndpoint(
  baseUrl: string | ((official?: boolean) => string) | undefined,
  official: boolean,
): string {
  const raw =
    typeof baseUrl === 'function'
      ? baseUrl(official)
      : typeof baseUrl === 'string' && baseUrl.trim()
        ? baseUrl.trim()
        : official
          ? DEFAULT_OFFICIAL_MCP_REGISTRY_URL
          : DEFAULT_GITHUB_MCP_REGISTRY_URL;
  const trimmed = raw.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${trimmed}/v0.1/servers`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

export async function searchMcpRegistry({
  query,
  official = false,
  limit = DEFAULT_LIMIT,
  baseUrl,
  fetchFn = globalThis.fetch,
}: SearchMcpRegistryParams): Promise<McpSearchCandidate[]> {
  const serversUrl = resolveRegistryEndpoint(baseUrl, official);
  const endpoint = `${serversUrl}?search=${encodeURIComponent(query)}&version=latest&limit=${limit}`;

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

  const text = await readBoundedText(response, 'MCP registry');
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

  const seen = new Set<string>();
  const candidates: McpSearchCandidate[] = [];
  for (const rawItem of envelope.data.servers) {
    const inner = extractInnerServer(rawItem);
    if (!inner) continue;
    let candidate: McpSearchCandidate | null;
    try {
      candidate = toCandidate(inner);
    } catch {
      continue;
    }
    if (!candidate || seen.has(candidate.server.name)) continue;
    seen.add(candidate.server.name);
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }

  return candidates;
}
