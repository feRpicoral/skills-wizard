import { z } from 'zod';

import {
  isBlockedEnvVarName,
  isEnvVarName,
  isMcpServerName,
  type McpServerDefinition,
  type McpValue,
  parseMcpCatalog,
} from './model.ts';

const CONTROL_CHAR = /\p{Cc}/u;
const UNSAFE_SPEC_TOKEN = /(?:^-|[\s\p{Cc}])/u;
const SAFE_FLAG_NAME = /^-{0,2}[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const registryEnvVarSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  value: z.string().optional(),
});

export const registryArgSchema = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  value: z.string().optional(),
  default: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
});

export const registryPackageSchema = z.looseObject({
  registryType: z.string().optional(),
  registry_name: z.string().optional(),
  identifier: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  runtimeHint: z.string().optional(),
  packageArguments: z.array(registryArgSchema).optional(),
  environmentVariables: z.array(registryEnvVarSchema).optional(),
});

export const registryHeaderSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  default: z.string().optional(),
  value: z.string().optional(),
});

export const registryRemoteSchema = z.looseObject({
  type: z.string().optional(),
  transport_type: z.string().optional(),
  url: z.string().min(1),
  headers: z.array(registryHeaderSchema).optional(),
});

export const registryServerInnerSchema = z.looseObject({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  packages: z.array(registryPackageSchema).optional(),
  remotes: z.array(registryRemoteSchema).optional(),
});

export type RegistryServerInner = z.infer<typeof registryServerInnerSchema>;

export interface McpSearchCandidate {
  name: string;
  fullName: string;
  description: string;
  transport: McpServerDefinition['transport'];
  version?: string;
  server: McpServerDefinition;
}

/**
 * Extracts and normalizes the trailing segment of a registry server identifier
 * (e.g. `io.github.upstash/@context7_mcp` -> `context7-mcp`), returning `null`
 * if the result is not a valid MCP server name.
 */
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

export function toSecretEnvName({
  raw,
  fallbackPrefix,
}: ToSecretEnvNameParams): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (cleaned && isEnvVarName(cleaned)) return cleaned;
  const rawPrefix = fallbackPrefix
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  const prefix = /^[0-9]/.test(rawPrefix) ? `MCP_${rawPrefix}` : rawPrefix;
  const candidate = `${prefix}_${cleaned || 'SECRET'}`;
  return isEnvVarName(candidate) ? candidate : 'MCP_SECRET_TOKEN';
}

export function buildPackageArgs(
  args: readonly z.infer<typeof registryArgSchema>[],
): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.isSecret) continue;
    const val = arg.value ?? arg.default;
    if (!val || CONTROL_CHAR.test(val)) continue;
    if (arg.type === 'named' && arg.name) {
      if (!SAFE_FLAG_NAME.test(arg.name)) continue;
      const flag = arg.name.startsWith('-') ? arg.name : `--${arg.name}`;
      out.push(flag, val);
    } else if (!val.startsWith('-')) {
      out.push(val);
    }
  }
  return out;
}

export function buildStdioEnv(
  vars: readonly z.infer<typeof registryEnvVarSchema>[],
  shortName: string,
): Record<string, McpValue> {
  const env: Record<string, McpValue> = {};
  for (const item of vars) {
    const key = item.name.trim();
    if (!isEnvVarName(key) || isBlockedEnvVarName(key)) {
      continue;
    }
    const literal = item.value ?? item.default;
    if (item.isSecret || !literal) {
      const secretName = toSecretEnvName({
        raw: key,
        fallbackPrefix: shortName,
      });
      if (isBlockedEnvVarName(secretName)) continue;
      env[key] = {
        secret: secretName,
        ...(item.isRequired === true ? {} : { optional: true }),
      };
    } else if (!CONTROL_CHAR.test(literal)) {
      env[key] = literal;
    }
  }
  return env;
}

export function buildRemoteHeaders(
  headers: readonly z.infer<typeof registryHeaderSchema>[],
  shortName: string,
): Record<string, McpValue> {
  const out: Record<string, McpValue> = {};
  for (const header of headers) {
    const literal = header.value ?? header.default;
    if (header.isSecret || !literal) {
      const defaultSecretName =
        header.name.toLowerCase() === 'authorization'
          ? toSecretEnvName({
              raw: `${shortName}_AUTH_TOKEN`,
              fallbackPrefix: 'MCP',
            })
          : toSecretEnvName({ raw: header.name, fallbackPrefix: shortName });
      out[header.name] = {
        secret: defaultSecretName,
        ...(header.isRequired === true ? {} : { optional: true }),
      };
    } else {
      out[header.name] = literal;
    }
  }
  return out;
}

function sanitizeDescription(raw: string | undefined): string {
  return (raw ?? '').replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

export interface DisambiguateShortServerNameParams {
  registryName: string;
  baseName: string;
  usedNames: ReadonlySet<string>;
}

/**
 * Resolves a unique MCP server name for `registryName` by trying `baseName`,
 * `<owner>-<baseName>`, `<namespace>-<baseName>`, and finally `<baseName>-<2..999>`
 * against `usedNames`.
 */
export function disambiguateShortServerName({
  registryName,
  baseName,
  usedNames,
}: DisambiguateShortServerNameParams): string | null {
  if (!usedNames.has(baseName)) return baseName;
  const slashIndex = registryName.lastIndexOf('/');
  if (slashIndex > 0) {
    const namespace = registryName.slice(0, slashIndex);
    const ownerRaw =
      namespace.split(/[./]/).filter(Boolean).at(-1) ?? namespace;
    const ownerSlug = deriveShortServerName(ownerRaw);
    if (ownerSlug && ownerSlug !== baseName) {
      const ownerCandidate = `${ownerSlug}-${baseName}`;
      if (isMcpServerName(ownerCandidate) && !usedNames.has(ownerCandidate)) {
        return ownerCandidate;
      }
    }
    const namespaceSlug = deriveShortServerName(namespace);
    if (namespaceSlug && namespaceSlug !== baseName) {
      const namespaceCandidate = `${namespaceSlug}-${baseName}`;
      if (
        isMcpServerName(namespaceCandidate) &&
        !usedNames.has(namespaceCandidate)
      ) {
        return namespaceCandidate;
      }
    }
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const numbered = `${baseName}-${suffix}`;
    if (isMcpServerName(numbered) && !usedNames.has(numbered)) {
      return numbered;
    }
  }
  return null;
}

interface BuildValidatedCandidateParams {
  rawServer: Record<string, unknown>;
  fullName: string;
  version?: string;
}

function buildValidatedCandidate({
  rawServer,
  fullName,
  version,
}: BuildValidatedCandidateParams): McpSearchCandidate | null {
  try {
    const validated = parseMcpCatalog({ servers: [rawServer] }, 'registry');
    const server = validated.servers[0];
    if (!server) return null;
    return {
      name: server.name,
      fullName,
      description: server.description,
      transport: server.transport,
      ...(version ? { version } : {}),
      server,
    };
  } catch {
    return null;
  }
}

interface PackageToCandidateParams {
  pkg: z.infer<typeof registryPackageSchema>;
  inner: RegistryServerInner;
  shortName: string;
  description: string;
}

function packageToCandidate({
  pkg,
  inner,
  shortName,
  description,
}: PackageToCandidateParams): McpSearchCandidate | null {
  const kind = (pkg.registryType ?? pkg.registry_name ?? '').toLowerCase();
  const hint = (pkg.runtimeHint ?? '').toLowerCase();
  const identifier = (pkg.identifier ?? pkg.name ?? '').trim();
  if (!identifier || UNSAFE_SPEC_TOKEN.test(identifier)) return null;
  const version = (pkg.version ?? inner.version ?? '').trim();
  if (version && UNSAFE_SPEC_TOKEN.test(version)) return null;
  const spec =
    version && !identifier.includes('@', 1)
      ? `${identifier}@${version}`
      : identifier;
  const extraArgs = buildPackageArgs(pkg.packageArguments ?? []);
  const env = buildStdioEnv(pkg.environmentVariables ?? [], shortName);

  if (kind === 'npm' || hint === 'npx') {
    return buildValidatedCandidate({
      rawServer: {
        name: shortName,
        description,
        scopes: ['global', 'project'],
        defaults: [],
        transport: 'stdio',
        command: 'npx',
        args: ['-y', spec, ...extraArgs],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
      fullName: inner.name,
      ...(version ? { version } : {}),
    });
  }

  if (kind === 'pypi' || hint === 'uvx') {
    return buildValidatedCandidate({
      rawServer: {
        name: shortName,
        description,
        scopes: ['global', 'project'],
        defaults: [],
        transport: 'stdio',
        command: 'uvx',
        args: [spec, ...extraArgs],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
      fullName: inner.name,
      ...(version ? { version } : {}),
    });
  }

  return null;
}

interface RemoteToCandidateParams {
  remote: z.infer<typeof registryRemoteSchema>;
  inner: RegistryServerInner;
  shortName: string;
  description: string;
}

function remoteToCandidate({
  remote,
  inner,
  shortName,
  description,
}: RemoteToCandidateParams): McpSearchCandidate | null {
  const rawType = (remote.type ?? remote.transport_type ?? '').toLowerCase();
  const transport =
    rawType === 'sse'
      ? 'sse'
      : rawType === 'http' || rawType === 'streamable-http'
        ? 'http'
        : null;
  if (!transport) return null;
  const headers = buildRemoteHeaders(remote.headers ?? [], shortName);
  return buildValidatedCandidate({
    rawServer: {
      name: shortName,
      description,
      scopes: ['global', 'project'],
      defaults: [],
      transport,
      url: remote.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    fullName: inner.name,
    ...(inner.version ? { version: inner.version } : {}),
  });
}

export interface ToCandidateParams {
  inner: RegistryServerInner;
  shortName: string;
}

export function toCandidate({
  inner,
  shortName,
}: ToCandidateParams): McpSearchCandidate | null {
  const description =
    sanitizeDescription(inner.description) || `${shortName} MCP server`;

  for (const pkg of inner.packages ?? []) {
    const candidate = packageToCandidate({
      pkg,
      inner,
      shortName,
      description,
    });
    if (candidate) return candidate;
  }

  for (const remote of inner.remotes ?? []) {
    const candidate = remoteToCandidate({
      remote,
      inner,
      shortName,
      description,
    });
    if (candidate) return candidate;
  }

  return null;
}
