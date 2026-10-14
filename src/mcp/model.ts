import { join } from 'node:path';

import { Document, isMap, isSeq, parse, parseDocument } from 'yaml';
import { z } from 'zod';

import { type Scope, SCOPES } from '../blocks/library.ts';
import { McpError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';

const MCP_CATALOG_DIR = 'mcp';
const MCP_CATALOG_FILE = 'servers.yaml';
const MCP_SERVER_NAME = /^[a-z0-9-]+$/;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SINGLE_LINE = /^[^\r\n\p{Cc}]+$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);
const YAML_OUTPUT = { lineWidth: 0, flowCollectionPadding: false } as const;

export const BLOCKED_ENV_VARS: ReadonlySet<string> = new Set([
  'BASH_ENV',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NPM_CONFIG_REGISTRY',
  'PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'UV_EXTRA_INDEX_URL',
  'UV_INDEX_URL',
]);

export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_DETECT_KEYS = ['nx', 'supabase', 'sentry'] as const;
export type McpDetectKey = (typeof MCP_DETECT_KEYS)[number];

export function isMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME.test(name);
}

export function isEnvVarName(name: string): boolean {
  return ENV_VAR_NAME.test(name);
}

export function isBlockedEnvVarName(name: string): boolean {
  return BLOCKED_ENV_VARS.has(name.toUpperCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

const secretValueSchema = z.strictObject({
  secret: z
    .string()
    .refine(isEnvVarName, 'must be a valid environment variable name'),
  optional: z.boolean().optional(),
});

const mcpValueSchema = z.union([z.string(), secretValueSchema]);

export type McpSecretValue = z.infer<typeof secretValueSchema>;
export type McpValue = z.infer<typeof mcpValueSchema>;

export function isSecretValue(value: McpValue): value is McpSecretValue {
  return typeof value === 'object' && value !== null && 'secret' in value;
}

function collectServerSecrets(
  server: McpServerDefinition,
  requiredOnly: boolean,
): string[] {
  const values =
    server.transport === 'stdio'
      ? Object.values(server.env)
      : Object.values(server.headers);
  const secrets = new Set<string>();
  for (const val of values) {
    if (isSecretValue(val) && (!requiredOnly || !val.optional)) {
      secrets.add(val.secret);
    }
  }
  return [...secrets];
}

export function requiredServerSecrets(server: McpServerDefinition): string[] {
  return collectServerSecrets(server, true);
}

export function allServerSecrets(server: McpServerDefinition): string[] {
  return collectServerSecrets(server, false);
}

const toolFilterSchema = z.strictObject({
  allow: z.array(z.string().min(1)).min(1).optional(),
  deny: z.array(z.string().min(1)).min(1).optional(),
});

export type McpToolFilter = z.infer<typeof toolFilterSchema>;

const baseServerFields = {
  name: z
    .string()
    .refine(
      isMcpServerName,
      'must contain only lowercase letters, digits, and hyphens',
    ),
  description: z.string().min(1).regex(SINGLE_LINE, 'must be a single line'),
  scopes: z.array(z.enum(SCOPES)).min(1),
  defaults: z.array(z.enum(SCOPES)).default([]),
  detect: z.enum(MCP_DETECT_KEYS).optional(),
  tools: toolFilterSchema.optional(),
  estimatedTools: z.number().int().positive().optional(),
};

const stdioServerSchema = z.strictObject({
  ...baseServerFields,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string().min(1), mcpValueSchema).default({}),
});

function remoteServerSchema<T extends 'http' | 'sse'>(transport: T) {
  return z.strictObject({
    ...baseServerFields,
    transport: z.literal(transport),
    url: z
      .string()
      .refine(
        isHttpUrl,
        'must be an https:// URL (or http:// on localhost) without credentials',
      ),
    headers: z.record(z.string().min(1), mcpValueSchema).default({}),
  });
}

const httpServerSchema = remoteServerSchema('http');
const sseServerSchema = remoteServerSchema('sse');

const serverSchema = z.discriminatedUnion('transport', [
  stdioServerSchema,
  httpServerSchema,
  sseServerSchema,
]);

const catalogSchema = z.strictObject({
  servers: z.array(serverSchema),
});

export type McpStdioServer = z.infer<typeof stdioServerSchema>;
export type McpRemoteServer =
  z.infer<typeof httpServerSchema> | z.infer<typeof sseServerSchema>;
export type McpServerDefinition = z.infer<typeof serverSchema>;
export type McpCatalog = z.infer<typeof catalogSchema>;

export function mcpCatalogPath(repoRoot: string): string {
  return join(repoRoot, MCP_CATALOG_DIR, MCP_CATALOG_FILE);
}

function checkServers(catalog: McpCatalog, file: string): void {
  const names = new Set<string>();
  for (const server of catalog.servers) {
    if (names.has(server.name)) {
      throw new McpError(`${file}: ${server.name} is listed twice`);
    }
    names.add(server.name);
    const outside = server.defaults.filter(
      (scope) => !server.scopes.includes(scope),
    );
    if (outside.length > 0) {
      throw new McpError(
        `${file}: ${server.name} has defaults outside its scopes: ${outside.join(', ')}`,
      );
    }
    if (server.transport === 'stdio') {
      for (const envKey of Object.keys(server.env)) {
        if (!isEnvVarName(envKey)) {
          throw new McpError(
            `${file}: ${server.name} has invalid env variable name "${envKey}"`,
          );
        }
        if (isBlockedEnvVarName(envKey)) {
          throw new McpError(
            `${file}: ${server.name} cannot set blocked env variable "${envKey}"`,
          );
        }
      }
    }
  }
}

/**
 * Validates a parsed MCP catalog object against the catalog schema and checks
 * cross-field invariants (unique server names, `defaults` subset of `scopes`,
 * and safe `stdio` environment variable names).
 *
 * @throws {McpError} If `raw` fails schema validation or violates catalog invariants.
 */
export function parseMcpCatalog(raw: unknown, file: string): McpCatalog {
  const result = catalogSchema.safeParse(raw);
  if (!result.success) {
    throw new McpError(`${file}: ${z.prettifyError(result.error)}`);
  }
  checkServers(result.data, file);
  return result.data;
}

export async function loadMcpCatalog(file: string): Promise<McpCatalog> {
  const source = await readTextIfExists(file);
  if (source === null) return { servers: [] };

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new McpError(`${file} is not valid YAML`, { cause: error });
  }
  return parseMcpCatalog(raw, file);
}

export function findMcpServer(
  catalog: McpCatalog,
  name: string,
): McpServerDefinition | undefined {
  return catalog.servers.find((server) => server.name === name);
}

export function defaultMcpServerNames(
  catalog: McpCatalog,
  scope: Scope,
): string[] {
  return catalog.servers
    .filter((server) => server.defaults.includes(scope))
    .map((server) => server.name);
}

export function detectedMcpServerNames(
  catalog: McpCatalog,
  detectedKeys: readonly string[],
): string[] {
  const keys = new Set(detectedKeys);
  return catalog.servers
    .filter(
      (server) =>
        server.scopes.includes('project') &&
        server.detect !== undefined &&
        keys.has(server.detect),
    )
    .map((server) => server.name);
}

export function unknownMcpServerNames(
  catalog: McpCatalog,
  names: readonly string[],
): string[] {
  return names.filter((name) => !findMcpServer(catalog, name));
}

export interface SelectMcpServersParams {
  catalog: McpCatalog;
  names: readonly string[];
  scope: Scope;
}

export function outOfScopeMcpServerNames({
  catalog,
  names,
  scope,
}: SelectMcpServersParams): string[] {
  return catalog.servers
    .filter(
      (server) => names.includes(server.name) && !server.scopes.includes(scope),
    )
    .map((server) => server.name);
}

export function selectMcpServers({
  catalog,
  names,
  scope,
}: SelectMcpServersParams): McpServerDefinition[] {
  const unknown = unknownMcpServerNames(catalog, names);
  if (unknown.length > 0) {
    throw new McpError(`Unknown MCP servers: ${unknown.join(', ')}`);
  }
  const outOfScope = outOfScopeMcpServerNames({ catalog, names, scope });
  if (outOfScope.length > 0) {
    throw new McpError(
      `MCP servers not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
  const wanted = new Set(names);
  return catalog.servers.filter((server) => wanted.has(server.name));
}

export interface ExtendMcpCatalogParams {
  catalog: McpCatalog;
  servers: readonly McpServerDefinition[];
  file: string;
}

export function extendMcpCatalog({
  catalog,
  servers,
  file,
}: ExtendMcpCatalogParams): McpCatalog {
  return parseMcpCatalog({ servers: [...catalog.servers, ...servers] }, file);
}

function serializeServerPlain(
  server: McpServerDefinition,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    name: server.name,
    description: server.description,
    scopes: server.scopes,
  };
  if (server.defaults.length > 0) {
    record.defaults = server.defaults;
  }
  if (server.detect !== undefined) {
    record.detect = server.detect;
  }
  record.transport = server.transport;
  if (server.transport === 'stdio') {
    record.command = server.command;
    if (server.args.length > 0) {
      record.args = server.args;
    }
    if (server.cwd !== undefined) {
      record.cwd = server.cwd;
    }
    if (Object.keys(server.env).length > 0) {
      record.env = server.env;
    }
  } else {
    record.url = server.url;
    if (Object.keys(server.headers).length > 0) {
      record.headers = server.headers;
    }
  }
  if (server.tools !== undefined) {
    record.tools = server.tools;
  }
  if (server.estimatedTools !== undefined) {
    record.estimatedTools = server.estimatedTools;
  }
  return record;
}

function serverNode(doc: Document, server: McpServerDefinition) {
  const node = doc.createNode(serializeServerPlain(server));
  for (const key of ['scopes', 'defaults', 'args']) {
    const list = node.get(key, true);
    if (isSeq(list)) list.flow = true;
  }
  const tools = node.get('tools', true);
  if (isMap(tools)) {
    for (const key of ['allow', 'deny']) {
      const list = tools.get(key, true);
      if (isSeq(list)) list.flow = true;
    }
  }
  return node;
}

interface CatalogDocumentParams {
  source: string | null;
  file: string;
}

function catalogDocument({ source, file }: CatalogDocumentParams): Document {
  if (source === null || source.trim() === '') {
    return new Document({ servers: [] });
  }
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    throw new McpError(`${file} is not valid YAML`, {
      cause: doc.errors[0],
    });
  }
  return doc;
}

/**
 * Appends `servers` to the `servers` sequence in `file` while preserving
 * existing YAML comments and formatting, and writes the updated document
 * atomically.
 *
 * @throws {McpError} If `file` is not valid YAML or the extended catalog fails validation.
 */
export async function appendMcpServers(
  file: string,
  servers: readonly McpServerDefinition[],
): Promise<McpCatalog> {
  const source = await readTextIfExists(file);
  const doc = catalogDocument({ source, file });
  const current = parseMcpCatalog(doc.toJS(), file);
  const next = extendMcpCatalog({ catalog: current, servers, file });

  const list = doc.get('servers', true);
  if (!isSeq(list)) {
    throw new McpError(`${file}: servers must be a list`);
  }
  if (list.items.length === 0) list.flow = false;
  for (const server of next.servers.slice(current.servers.length)) {
    const node = serverNode(doc, server);
    node.spaceBefore = list.items.length > 0;
    list.items.push(node);
  }

  await writeTextAtomic({ path: file, content: doc.toString(YAML_OUTPUT) });
  return next;
}

export function formatMcpServerYaml(server: McpServerDefinition): string {
  const doc = new Document({ servers: [] });
  const list = doc.get('servers', true);
  if (isSeq(list)) {
    list.flow = false;
    list.items.push(serverNode(doc, server));
  }
  return doc.toString(YAML_OUTPUT);
}
