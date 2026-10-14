import {
  isSecretValue,
  type McpRemoteServer,
  type McpServerDefinition,
  type McpStdioServer,
  type McpValue,
} from './model.ts';

export type McpTargetClient =
  | 'antigravity'
  | 'claude-code'
  | 'codex'
  | 'gemini-cli'
  | 'copilot'
  | 'claude-copilot-shared';

export type McpJsonClient = Exclude<McpTargetClient, 'codex'>;

export interface RenderedMcpJsonResult {
  servers: Record<string, Record<string, unknown>>;
  serverNames: string[];
  warnings: string[];
}

export interface RenderedMcpTomlResult {
  body: string;
  serverNames: string[];
  warnings: string[];
}

export interface RenderMcpJsonParams {
  client: McpJsonClient;
  servers: readonly McpServerDefinition[];
}

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f');
}

function formatTomlKey(key: string): string {
  return BARE_TOML_KEY.test(key) ? key : formatTomlString(key);
}

function formatTomlStringArray(items: readonly string[]): string {
  return `[${items.map((item) => formatTomlString(item)).join(', ')}]`;
}

function formatTomlInlineTable(
  entries: readonly (readonly [string, string])[],
): string {
  const members = entries.map(
    ([key, value]) => `${formatTomlKey(key)} = ${formatTomlString(value)}`,
  );
  return `{ ${members.join(', ')} }`;
}

function expandEnvSecrets(
  env: Readonly<Record<string, McpValue>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretValue(value) ? `\${${value.secret}}` : value;
  }
  return out;
}

function expandHeaderSecrets(
  headers: Readonly<Record<string, McpValue>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isSecretValue(value)) {
      out[key] =
        key.toLowerCase() === 'authorization'
          ? `Bearer \${${value.secret}}`
          : `\${${value.secret}}`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function literalStringEntries(
  map: Readonly<Record<string, McpValue>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function renderAntigravityStdio(
  server: McpStdioServer,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: server.command,
    args: [...server.args],
  };
  if (server.cwd !== undefined) {
    entry.cwd = server.cwd;
  }
  const literalEnv = literalStringEntries(server.env);
  if (Object.keys(literalEnv).length > 0) {
    entry.env = literalEnv;
  }
  if (server.tools?.allow && server.tools.allow.length > 0) {
    entry.enabledTools = [...server.tools.allow];
  }
  if (server.tools?.deny && server.tools.deny.length > 0) {
    entry.disabledTools = [...server.tools.deny];
  }
  return entry;
}

function renderAntigravityRemote(
  server: McpRemoteServer,
  warnings: string[],
): Record<string, unknown> | null {
  for (const [headerName, value] of Object.entries(server.headers)) {
    if (isSecretValue(value) && !value.optional) {
      warnings.push(
        `Skipping MCP server "${server.name}" for Antigravity: remote header "${headerName}" requires secret ${value.secret}, which Antigravity does not expand in mcp_config.json.`,
      );
      return null;
    }
  }
  const entry: Record<string, unknown> = {
    url: server.url,
    serverUrl: server.url,
  };
  const literalHeaders = literalStringEntries(server.headers);
  if (Object.keys(literalHeaders).length > 0) {
    entry.headers = literalHeaders;
  }
  if (server.tools?.allow && server.tools.allow.length > 0) {
    entry.enabledTools = [...server.tools.allow];
  }
  if (server.tools?.deny && server.tools.deny.length > 0) {
    entry.disabledTools = [...server.tools.deny];
  }
  return entry;
}

interface RenderExpandedServerParams {
  server: McpServerDefinition;
  includeStdioType: boolean;
}

function renderExpandedServer({
  server,
  includeStdioType,
}: RenderExpandedServerParams): Record<string, unknown> {
  if (server.transport === 'stdio') {
    const entry: Record<string, unknown> = {
      ...(includeStdioType ? { type: 'stdio' } : {}),
      command: server.command,
      args: [...server.args],
    };
    if (server.cwd !== undefined) {
      entry.cwd = server.cwd;
    }
    if (Object.keys(server.env).length > 0) {
      entry.env = expandEnvSecrets(server.env);
    }
    return entry;
  }
  const entry: Record<string, unknown> = {
    type: server.transport,
    url: server.url,
  };
  if (Object.keys(server.headers).length > 0) {
    entry.headers = expandHeaderSecrets(server.headers);
  }
  return entry;
}

interface RenderJsonServerParams {
  client: McpJsonClient;
  server: McpServerDefinition;
  warnings: string[];
}

function renderJsonServer({
  client,
  server,
  warnings,
}: RenderJsonServerParams): Record<string, unknown> | null {
  switch (client) {
    case 'antigravity':
      return server.transport === 'stdio'
        ? renderAntigravityStdio(server)
        : renderAntigravityRemote(server, warnings);
    case 'claude-code': {
      if (server.tools?.allow && server.tools.allow.length > 0) {
        warnings.push(
          `MCP server "${server.name}" defines tools.allow, which Claude Code does not support in MCP config; all tools not in tools.deny remain enabled.`,
        );
      }
      return renderExpandedServer({ server, includeStdioType: false });
    }
    case 'gemini-cli': {
      const entry = renderExpandedServer({ server, includeStdioType: false });
      if (server.tools?.allow && server.tools.allow.length > 0) {
        entry.includeTools = [...server.tools.allow];
      }
      if (server.tools?.deny && server.tools.deny.length > 0) {
        entry.excludeTools = [...server.tools.deny];
      }
      return entry;
    }
    case 'copilot':
    case 'claude-copilot-shared': {
      if (
        client === 'claude-copilot-shared' &&
        server.tools?.allow &&
        server.tools.allow.length > 0
      ) {
        warnings.push(
          `MCP server "${server.name}" defines tools.allow, which Claude Code ignores in shared .mcp.json.`,
        );
      }
      if (server.tools?.deny && server.tools.deny.length > 0) {
        warnings.push(
          client === 'copilot'
            ? `MCP server "${server.name}" defines tools.deny, which GitHub Copilot does not support in mcp-config.json.`
            : `MCP server "${server.name}" defines tools.deny, which GitHub Copilot ignores in shared .mcp.json (enforced only for Claude Code via permissions.deny).`,
        );
      }
      const entry = renderExpandedServer({ server, includeStdioType: true });
      entry.tools =
        server.tools?.allow && server.tools.allow.length > 0
          ? [...server.tools.allow]
          : ['*'];
      return entry;
    }
  }
}

/**
 * Renders MCP server definitions into the target JSON client's native `mcpServers`
 * schema, collecting warnings for unsupported transport or tool-filter features.
 *
 * Servers that cannot be represented safely for `client` (such as Antigravity
 * remote servers with required secret headers) are omitted from `servers` and
 * `serverNames` with an explanatory warning.
 */
export function renderMcpJsonServers({
  client,
  servers,
}: RenderMcpJsonParams): RenderedMcpJsonResult {
  const rendered: Record<string, Record<string, unknown>> = {};
  const serverNames: string[] = [];
  const warnings: string[] = [];

  for (const server of servers) {
    const config = renderJsonServer({ client, server, warnings });
    if (config !== null) {
      rendered[server.name] = config;
      serverNames.push(server.name);
    }
  }

  return {
    servers: rendered,
    serverNames,
    warnings,
  };
}

function appendTomlToolFilters(
  lines: string[],
  server: McpServerDefinition,
): void {
  if (server.tools?.allow && server.tools.allow.length > 0) {
    lines.push(`enabled_tools = ${formatTomlStringArray(server.tools.allow)}`);
  }
  if (server.tools?.deny && server.tools.deny.length > 0) {
    lines.push(`disabled_tools = ${formatTomlStringArray(server.tools.deny)}`);
  }
}

function renderCodexStdioBlock(server: McpStdioServer): string {
  const lines = [
    `[mcp_servers.${server.name}]`,
    `command = ${formatTomlString(server.command)}`,
  ];
  if (server.args.length > 0) {
    lines.push(`args = ${formatTomlStringArray(server.args)}`);
  }
  if (server.cwd !== undefined) {
    lines.push(`cwd = ${formatTomlString(server.cwd)}`);
  }
  const secretVars = [
    ...new Set(
      Object.values(server.env).flatMap((val) =>
        isSecretValue(val) ? [val.secret] : [],
      ),
    ),
  ];
  if (secretVars.length > 0) {
    lines.push(`env_vars = ${formatTomlStringArray(secretVars)}`);
  }
  appendTomlToolFilters(lines, server);

  const literalEnv = Object.entries(server.env).flatMap(([key, val]) =>
    typeof val === 'string' ? ([[key, val]] as const) : [],
  );
  if (literalEnv.length > 0) {
    lines.push('', `[mcp_servers.${server.name}.env]`);
    for (const [key, val] of literalEnv) {
      lines.push(`${formatTomlKey(key)} = ${formatTomlString(val)}`);
    }
  }
  return lines.join('\n');
}

function renderCodexHttpBlock(server: McpRemoteServer): string {
  const lines = [
    `[mcp_servers.${server.name}]`,
    `url = ${formatTomlString(server.url)}`,
  ];
  let bearerVar: string | undefined;
  const envHeaders: (readonly [string, string])[] = [];
  const literalHeaders: (readonly [string, string])[] = [];

  for (const [key, value] of Object.entries(server.headers)) {
    if (isSecretValue(value)) {
      if (key.toLowerCase() === 'authorization' && bearerVar === undefined) {
        bearerVar = value.secret;
      } else {
        envHeaders.push([key, value.secret]);
      }
    } else {
      literalHeaders.push([key, value]);
    }
  }
  if (bearerVar !== undefined) {
    lines.push(`bearer_token_env_var = ${formatTomlString(bearerVar)}`);
  }
  if (envHeaders.length > 0) {
    lines.push(`env_http_headers = ${formatTomlInlineTable(envHeaders)}`);
  }
  if (literalHeaders.length > 0) {
    lines.push(`http_headers = ${formatTomlInlineTable(literalHeaders)}`);
  }
  appendTomlToolFilters(lines, server);
  return lines.join('\n');
}

/**
 * Renders MCP server definitions into Codex `[mcp_servers.<name>]` TOML blocks.
 *
 * Skips `sse` servers with a warning because Codex supports only `stdio` and
 * Streamable HTTP transports.
 */
export function renderMcpTomlServers(
  servers: readonly McpServerDefinition[],
): RenderedMcpTomlResult {
  const blocks: string[] = [];
  const serverNames: string[] = [];
  const warnings: string[] = [];

  for (const server of servers) {
    if (server.transport === 'sse') {
      warnings.push(
        `Skipping MCP server "${server.name}" for Codex: Codex does not support SSE MCP servers.`,
      );
      continue;
    }
    blocks.push(
      server.transport === 'stdio'
        ? renderCodexStdioBlock(server)
        : renderCodexHttpBlock(server),
    );
    serverNames.push(server.name);
  }

  return {
    body: blocks.join('\n\n'),
    serverNames,
    warnings,
  };
}

/**
 * Formats `tools.deny` entries across `servers` as Claude Code `permissions.deny`
 * rules (`mcp__<server>__<tool>`), preserving order and deduplicating rules.
 */
export function claudeDeniedToolPermissions(
  servers: readonly McpServerDefinition[],
): string[] {
  const denied: string[] = [];
  for (const server of servers) {
    for (const tool of server.tools?.deny ?? []) {
      const rule = `mcp__${server.name}__${tool}`;
      if (!denied.includes(rule)) {
        denied.push(rule);
      }
    }
  }
  return denied;
}
