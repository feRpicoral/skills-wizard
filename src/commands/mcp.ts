import { resolve } from 'node:path';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { isDirectory, lstatIfExists } from '../install/fs.ts';
import type { McpCatalog, McpServerDefinition } from '../mcp/model.ts';
import { promptScope } from '../prompts/selection.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import { projectManifestPath } from '../state/manifest.ts';
import type { ToolId } from '../tools/registry.ts';
import { runMcpSearch } from './mcp-search.ts';
import {
  buildSyncPlanForLocation,
  checkExplicitMcp,
  confirmAndApply,
  dropUnavailableMcpServers,
  loadLibrary,
  loadMcpServers,
  mergeRequestedTools,
  readLocationManifest,
  resolveLocation,
} from './shared.ts';

export type McpSubcommand = 'list' | 'add' | 'remove' | 'search';

export interface McpOptions {
  subcommand: McpSubcommand;
  args: string[];
  scope?: Scope;
  projectDir?: string;
  tools?: ToolId[];
  official?: boolean;
  limit?: number;
  add?: boolean;
  yes: boolean;
  dryRun: boolean;
}

interface FormatServerLineParams {
  server: McpServerDefinition;
  status: string;
}

function formatServerLine({ server, status }: FormatServerLineParams): string {
  const scopes = server.scopes.join(',');
  const tools =
    server.estimatedTools !== undefined
      ? `, ~${server.estimatedTools} tools`
      : '';
  return `${server.name}  [${status}]  (${server.transport}, scopes: ${scopes}${tools}) - ${server.description}`;
}

interface RunMcpListParams {
  ctx: Context;
  catalog: McpCatalog;
  scope?: Scope;
  projectDir?: string;
}

async function runMcpList({
  ctx,
  catalog,
  scope,
  projectDir,
}: RunMcpListParams): Promise<number> {
  if (scope !== undefined) {
    const location = await resolveLocation({
      ctx,
      scope,
      projectDir,
    });
    const manifest = await readLocationManifest({
      ctx,
      prompting: false,
      location,
    });
    const installed = new Set(manifest?.mcp ?? []);
    const available = catalog.servers.filter((server) =>
      server.scopes.includes(scope),
    );
    if (available.length === 0) {
      ctx.print(`No MCP servers available for ${scope} scope.`);
      return 0;
    }
    for (const server of available) {
      const status = installed.has(server.name) ? 'installed' : 'available';
      ctx.print(formatServerLine({ server, status }));
    }
    return 0;
  }

  const globalLocation = await resolveLocation({ ctx, scope: 'global' });
  const globalManifest = await readLocationManifest({
    ctx,
    prompting: false,
    location: globalLocation,
  });

  const candidateDir = resolve(ctx.cwd, projectDir ?? '.');
  const hasProjectManifest =
    projectDir !== undefined ||
    ((await isDirectory(candidateDir)) &&
      (await lstatIfExists(projectManifestPath(candidateDir))) !== null);
  const projectLocation = hasProjectManifest
    ? await resolveLocation({
        ctx,
        scope: 'project',
        projectDir,
      })
    : null;
  const projectManifest = projectLocation
    ? await readLocationManifest({
        ctx,
        prompting: false,
        location: projectLocation,
      })
    : null;

  const globalInstalled = new Set(globalManifest?.mcp ?? []);
  const projectInstalled = new Set(projectManifest?.mcp ?? []);

  for (const server of catalog.servers) {
    const installedIn: string[] = [];
    if (globalInstalled.has(server.name)) installedIn.push('global');
    if (projectInstalled.has(server.name)) installedIn.push('project');
    const status =
      installedIn.length > 0
        ? `installed: ${installedIn.join(', ')}`
        : 'available';
    ctx.print(formatServerLine({ server, status }));
  }
  return 0;
}

interface ApplyMcpSelectionChangeParams {
  ctx: Context;
  prompting: boolean;
  catalog: McpCatalog;
  mode: 'add' | 'remove';
  names: readonly string[];
  requestedScope?: Scope;
  projectDir?: string;
  requestedTools?: ToolId[];
  yes: boolean;
  dryRun: boolean;
}

async function applyMcpSelectionChange({
  ctx,
  prompting,
  catalog,
  mode,
  names,
  requestedScope,
  projectDir,
  requestedTools,
  yes,
  dryRun,
}: ApplyMcpSelectionChangeParams): Promise<number> {
  if (names.length === 0) {
    throw new UsageError(
      mode === 'add'
        ? 'Pass one or more MCP server names to add, for example: agents-config mcp add context7'
        : 'Pass one or more MCP server names to remove, for example: agents-config mcp remove context7',
    );
  }

  const scope = requestedScope ?? (prompting ? await promptScope() : 'global');
  const location = await resolveLocation({
    ctx,
    scope,
    projectDir,
  });
  const previous = await readLocationManifest({ ctx, prompting, location });
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath({ path: location.manifestPath, home: ctx.paths.home })}; run agents-config init ${scope === 'project' ? '--project' : '--global'} first.`,
    );
  }

  const uniqueNames = [...new Set(names)];
  let mcp: string[];
  if (mode === 'add') {
    checkExplicitMcp({ catalog, names: uniqueNames, scope });
    const priorMcp = dropUnavailableMcpServers({
      ctx,
      prompting,
      catalog,
      names: previous.mcp,
      scope,
    });
    mcp = [...new Set([...priorMcp, ...uniqueNames])];
  } else {
    const notInstalled = uniqueNames.filter(
      (name) => !previous.mcp.includes(name),
    );
    if (notInstalled.length > 0) {
      throw new UsageError(
        `MCP server${notInstalled.length === 1 ? '' : 's'} not installed in ${scope} scope: ${notInstalled.join(', ')}`,
      );
    }
    const removeSet = new Set(uniqueNames);
    mcp = dropUnavailableMcpServers({
      ctx,
      prompting,
      catalog,
      names: previous.mcp.filter((name) => !removeSet.has(name)),
      scope,
    });
  }

  const tools = mergeRequestedTools(previous.tools, requestedTools);

  if (tools.length === 0) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  const library = await loadLibrary(ctx);
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const plan = await buildSyncPlanForLocation({
    ctx,
    prompting,
    location,
    previous,
    library,
    skillLibrary,
    mcpCatalog: catalog,
    tools,
    mcpOverride: mcp,
    warnLocked: scope === 'global' && mode === 'add',
  });

  const result = await confirmAndApply(ctx, plan, { yes, dryRun });
  return result.code;
}

export async function runMcp(
  ctx: Context,
  {
    subcommand,
    args,
    scope,
    projectDir,
    tools,
    official = false,
    limit,
    add = false,
    yes,
    dryRun,
  }: McpOptions,
): Promise<number> {
  const prompting = ctx.interactive && !yes;
  const catalog = await loadMcpServers(ctx);

  if (subcommand === 'list') {
    if (args.length > 0) {
      throw new UsageError(
        `Unexpected arguments for mcp list: ${args.join(' ')}`,
      );
    }
    return runMcpList({
      ctx,
      catalog,
      scope,
      projectDir,
    });
  }

  if (subcommand === 'add' || subcommand === 'remove') {
    if (subcommand === 'remove' && tools !== undefined) {
      throw new UsageError('--tools only applies to mcp add.');
    }
    return applyMcpSelectionChange({
      ctx,
      prompting,
      catalog,
      mode: subcommand,
      names: args,
      requestedScope: scope,
      projectDir,
      requestedTools: tools,
      yes,
      dryRun,
    });
  }

  const query = args.join(' ');
  return runMcpSearch({
    ctx,
    prompting,
    catalog,
    query,
    official,
    limit,
    add,
    yes,
    dryRun,
  });
}
