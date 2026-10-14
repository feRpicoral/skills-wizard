import { join } from 'node:path';

import type { Paths } from '../env.ts';
import { type McpServerDefinition, selectMcpServers } from '../mcp/model.ts';
import {
  claudeDeniedToolPermissions,
  type McpJsonClient,
  renderMcpJsonServers,
  renderMcpTomlServers,
} from '../mcp/render.ts';
import type { McpConfigPaths } from '../state/manifest.ts';
import {
  TOOL_IDS,
  type ToolDefinition,
  type ToolMcpClient,
  TOOLS,
} from '../tools/registry.ts';
import type { PlanInput, Target } from './targets.ts';

export interface McpTargetsResult {
  targets: Target[];
  warnings: string[];
}

interface ResolvedMcpConfigGroup {
  format: 'json' | 'toml';
  path: string;
  tools: ToolDefinition[];
  clients: Set<ToolMcpClient>;
  permissionsFiles: { tool: ToolDefinition; path: string }[];
}

function groupToolsByMcpPath(
  tools: readonly ToolDefinition[],
  resolve: (tool: ToolDefinition) =>
    | {
        format: 'json';
        client: ToolMcpClient;
        path: string;
        permissionsPath?: string;
      }
    | { format: 'toml'; path: string }
    | undefined,
): ResolvedMcpConfigGroup[] {
  const groups = new Map<string, ResolvedMcpConfigGroup>();

  for (const tool of tools) {
    const resolved = resolve(tool);
    if (!resolved) continue;

    const key = `${resolved.format}:${resolved.path}`;
    const existing = groups.get(key) ?? {
      format: resolved.format,
      path: resolved.path,
      tools: [],
      clients: new Set<ToolMcpClient>(),
      permissionsFiles: [],
    };
    existing.tools.push(tool);

    if (resolved.format === 'json') {
      existing.clients.add(resolved.client);
      if (resolved.permissionsPath !== undefined) {
        existing.permissionsFiles.push({
          tool,
          path: resolved.permissionsPath,
        });
      }
    }

    groups.set(key, existing);
  }

  return [...groups.values()];
}

function resolveGroupClient(
  clients: ReadonlySet<ToolMcpClient>,
): McpJsonClient {
  if (clients.has('claude-code') && clients.has('copilot')) {
    return 'claude-copilot-shared';
  }

  const [first] = clients;
  return first ?? 'claude-code';
}

function buildMcpTargetsFromGroups(
  groups: readonly ResolvedMcpConfigGroup[],
  servers: readonly McpServerDefinition[],
): McpTargetsResult {
  if (servers.length === 0) return { targets: [], warnings: [] };

  const targets: Target[] = [];
  const warnings: string[] = [];

  for (const group of groups) {
    const label = `${group.tools.map((tool) => tool.label).join(', ')} MCP servers`;

    if (group.format === 'toml') {
      const rendered = renderMcpTomlServers(servers);
      warnings.push(...rendered.warnings);

      if (rendered.serverNames.length > 0) {
        targets.push({
          kind: 'mcp-toml',
          path: group.path,
          body: rendered.body,
          serverNames: rendered.serverNames,
          label,
        });
      }

      continue;
    }

    const client = resolveGroupClient(group.clients);
    const rendered = renderMcpJsonServers({ client, servers });
    warnings.push(...rendered.warnings);

    if (rendered.serverNames.length > 0) {
      targets.push({
        kind: 'mcp-json',
        path: group.path,
        servers: rendered.servers,
        mcpClient: client,
        label,
      });
    }

    for (const perm of group.permissionsFiles) {
      if (perm.tool.id !== 'claude-code') continue;

      const denied = claudeDeniedToolPermissions(servers);

      if (denied.length > 0) {
        targets.push({
          kind: 'json-array',
          path: perm.path,
          key: 'permissions.deny',
          values: denied,
          mcpPermissionClient: 'claude-code',
          label: `${perm.tool.label} MCP tool permissions`,
        });
      }
    }
  }

  return {
    targets,
    warnings: [...new Set(warnings)],
  };
}

export function selectedMcpServers(input: PlanInput): McpServerDefinition[] {
  const names = input.selection.mcp ?? [];
  if (!input.mcpCatalog || names.length === 0) return [];

  return selectMcpServers({
    catalog: input.mcpCatalog,
    names,
    scope: input.scope,
  });
}

export interface GlobalMcpTargetsParams {
  tools: readonly ToolDefinition[];
  servers: readonly McpServerDefinition[];
  paths: Paths;
}

export function globalMcpTargets({
  tools,
  servers,
  paths,
}: GlobalMcpTargetsParams): McpTargetsResult {
  const groups = groupToolsByMcpPath(tools, (tool) => {
    const mcp = tool.global.mcp;
    if (!mcp) return undefined;

    if (mcp.format === 'toml') {
      return { format: 'toml', path: mcp.file(paths) };
    }

    return {
      format: 'json',
      client: mcp.client,
      path: mcp.file(paths),
      ...(mcp.permissionsFile
        ? { permissionsPath: mcp.permissionsFile(paths) }
        : {}),
    };
  });

  return buildMcpTargetsFromGroups(groups, servers);
}

export interface ProjectMcpTargetsParams {
  tools: readonly ToolDefinition[];
  servers: readonly McpServerDefinition[];
  projectDir: string;
}

export function projectMcpTargets({
  tools,
  servers,
  projectDir,
}: ProjectMcpTargetsParams): McpTargetsResult {
  const groups = groupToolsByMcpPath(tools, (tool) => {
    const mcp = tool.project.mcp;
    if (!mcp) return undefined;

    if (mcp.format === 'toml') {
      return { format: 'toml', path: join(projectDir, mcp.file) };
    }

    return {
      format: 'json',
      client: mcp.client,
      path: join(projectDir, mcp.file),
      ...(mcp.permissionsFile !== undefined
        ? { permissionsPath: join(projectDir, mcp.permissionsFile) }
        : {}),
    };
  });

  return buildMcpTargetsFromGroups(groups, servers);
}

export function mcpConfigPaths({
  scope,
  paths,
  project,
}: Pick<PlanInput, 'scope' | 'paths' | 'project'>): McpConfigPaths | null {
  if (scope === 'project' && !project) return null;

  const json = new Set<string>();
  const toml = new Set<string>();

  for (const id of TOOL_IDS) {
    const tool = TOOLS[id];
    if (scope === 'global') {
      const mcp = tool.global.mcp;
      if (!mcp) continue;

      const targetSet = mcp.format === 'json' ? json : toml;
      targetSet.add(mcp.file(paths));
    } else if (project) {
      const mcp = tool.project.mcp;
      if (!mcp) continue;

      const targetSet = mcp.format === 'json' ? json : toml;
      targetSet.add(join(project.dir, mcp.file));
    }
  }

  return {
    json: [...json],
    toml: [...toml],
  };
}
