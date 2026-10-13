import * as clack from '@clack/prompts';

import { withRequirements } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { isSystemError, McpError, UsageError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import { fsErrorReason } from '../install/fs.ts';
import { buildPlan } from '../install/plan.ts';
import {
  appendMcpServers,
  extendMcpCatalog,
  formatMcpServerYaml,
  loadMcpCatalog,
  type McpCatalog,
  mcpCatalogPath,
  type McpServerDefinition,
  outOfScopeMcpServerNames,
  type SelectMcpServersParams,
  unknownMcpServerNames,
} from '../mcp/model.ts';
import { searchMcpRegistry } from '../mcp/search.ts';
import {
  confirmApply,
  promptMcpSearchCandidate,
  promptScope,
} from '../prompts/selection.ts';
import { DEFAULT_SKILL_MODE } from '../skills/install.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  confirmAndApply,
  dropUnavailableBlocks,
  dropUnavailableMcpServers,
  dropUnknownPreset,
  dropUnknownSkills,
  fetchSkills,
  loadLibrary,
  notify,
  notifyLeftGit,
  readLocationManifest,
  resolveLocation,
  resolveVariables,
  warnLockedSkills,
  warnTrackedFiles,
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
      ...(projectDir !== undefined ? { projectDir } : {}),
    });
    const manifest = await readLocationManifest(ctx, false, location);
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
  const globalManifest = await readLocationManifest(
    ctx,
    false,
    globalLocation,
  ).catch(() => null);
  const projectLocation = await resolveLocation({
    ctx,
    scope: 'project',
    ...(projectDir !== undefined ? { projectDir } : {}),
  }).catch(() => null);
  const projectManifest = projectLocation
    ? await readLocationManifest(ctx, false, projectLocation).catch(() => null)
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

function validateRequestedServers({
  catalog,
  names,
  scope,
}: SelectMcpServersParams): void {
  const unknown = unknownMcpServerNames(catalog, names);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown MCP servers: ${unknown.join(', ')}`);
  }
  const outOfScope = outOfScopeMcpServerNames({ catalog, names, scope });
  if (outOfScope.length > 0) {
    throw new UsageError(
      `MCP servers not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
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
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  const previous = await readLocationManifest(ctx, prompting, location);
  if (!previous) {
    throw new UsageError(
      `Nothing recorded at ${displayPath({ path: location.manifestPath, home: ctx.paths.home })}; run agents-config init ${scope === 'project' ? '--project' : '--global'} first.`,
    );
  }

  const uniqueNames = [...new Set(names)];
  let mcp: string[];
  if (mode === 'add') {
    validateRequestedServers({ catalog, names: uniqueNames, scope });
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

  const tools =
    requestedTools !== undefined
      ? requestedTools.length === 0
        ? []
        : [...new Set([...previous.tools, ...requestedTools])]
      : previous.tools;
  if (tools.length === 0) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }

  const library = await loadLibrary(ctx);
  const baseBlocks = dropUnavailableBlocks({
    ctx,
    prompting,
    library,
    ids: previous.blocks,
    scope,
  });
  const { ids: blocks, added } = withRequirements(library, baseBlocks);
  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }
  const variables = await resolveVariables({
    ctx,
    prompting,
    library,
    blocks,
    location,
    recorded: previous.variables,
  });
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const skills = dropUnknownSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: previous.skills,
  });
  if (scope === 'global' && mode === 'add') {
    await warnLockedSkills(ctx, prompting, skills);
  }
  const skillSources = await fetchSkills({
    ctx,
    prompting,
    library: skillLibrary,
    names: tools.length > 0 ? skills : [],
  });
  const recordedLocal = previous.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  if (location.project && recordedLocal && !keepLocal) {
    notifyLeftGit(ctx, prompting, location.project.dir);
  }
  const preset = dropUnknownPreset({
    ctx,
    prompting,
    preset: previous.options.preset,
  });

  const plan = await buildPlan({
    scope,
    selection: {
      tools,
      blocks,
      skills,
      mcp,
      variables,
      linkCommand: previous.options.linkCommand ?? false,
      keepLocal,
      skillMode: previous.options.skillMode ?? DEFAULT_SKILL_MODE,
      ...(preset !== undefined ? { preset } : {}),
      ...(previous.options.style !== undefined
        ? { style: previous.options.style }
        : {}),
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
    skillSources,
    mcpCatalog: catalog,
  });
  if (keepLocal) {
    await warnTrackedFiles({
      ctx,
      prompting,
      plan,
      ...(location.project ? { project: location.project } : {}),
    });
  }

  const result = await confirmAndApply(ctx, plan, { yes, dryRun });
  return result.code;
}

async function writeMcpCatalogEntry(
  file: string,
  server: McpServerDefinition,
): Promise<void> {
  try {
    await appendMcpServers(file, [server]);
  } catch (error) {
    if (!isSystemError(error)) throw error;
    throw new McpError(
      `Could not update ${file} (${fsErrorReason(error) ?? error.message}), so ${server.name} was not added.`,
      { cause: error },
    );
  }
}

interface RunMcpSearchParams {
  ctx: Context;
  prompting: boolean;
  catalog: McpCatalog;
  query: string;
  official: boolean;
  limit?: number;
  add: boolean;
  yes: boolean;
  dryRun: boolean;
}

async function runMcpSearch({
  ctx,
  prompting,
  catalog,
  query,
  official,
  limit,
  add,
  yes,
  dryRun,
}: RunMcpSearchParams): Promise<number> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new UsageError(
      'Pass a search query, for example: agents-config mcp search sentry',
    );
  }

  const candidates = await searchMcpRegistry({
    query: trimmed,
    official,
    ...(ctx.sources.mcpRegistryUrl !== undefined
      ? { baseUrl: ctx.sources.mcpRegistryUrl }
      : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(ctx.sources.fetch ? { fetchFn: ctx.sources.fetch } : {}),
  });

  if (candidates.length === 0) {
    if (add) {
      throw new UsageError(`No MCP servers found matching "${trimmed}"`);
    }
    ctx.print(`No MCP servers found matching "${trimmed}".`);
    return 0;
  }

  for (const candidate of candidates) {
    ctx.print(
      `${candidate.name} (${candidate.fullName}, ${candidate.transport}) - ${candidate.description}`,
    );
  }

  if (!add) return 0;

  const lowerQuery = trimmed.toLowerCase();
  const chosen =
    prompting && candidates.length > 1
      ? await promptMcpSearchCandidate(candidates)
      : (candidates.find(
          (item) =>
            item.name === lowerQuery ||
            item.fullName.toLowerCase() === lowerQuery,
        ) ?? candidates[0]!);

  const file = mcpCatalogPath(ctx.repoRoot);
  extendMcpCatalog({
    catalog,
    servers: [chosen.server],
    file,
  });

  const snippet = formatMcpServerYaml(chosen.server).trimEnd();
  if (prompting) {
    clack.note(snippet, 'mcp/servers.yaml');
  } else {
    ctx.print(snippet);
  }

  if (dryRun) {
    notify({ ctx, prompting, message: 'Dry run: nothing was written.' });
    return 0;
  }
  if (!ctx.interactive && !yes) {
    ctx.print(
      'Re-run with --yes to add this server to mcp/servers.yaml, or --dry-run to preview it.',
    );
    return 1;
  }
  if (prompting && !(await confirmApply())) {
    notify({ ctx, prompting: true, message: 'Nothing was written.' });
    return 1;
  }

  await writeMcpCatalogEntry(file, chosen.server);
  notify({
    ctx,
    prompting,
    message: `Added to mcp/servers.yaml: ${chosen.server.name}`,
  });
  return 0;
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
  const catalog = await loadMcpCatalog(mcpCatalogPath(ctx.repoRoot));

  if (subcommand === 'list') {
    if (args.length > 0) {
      throw new UsageError(
        `Unexpected arguments for mcp list: ${args.join(' ')}`,
      );
    }
    return runMcpList({
      ctx,
      catalog,
      ...(scope !== undefined ? { scope } : {}),
      ...(projectDir !== undefined ? { projectDir } : {}),
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
      ...(scope !== undefined ? { requestedScope: scope } : {}),
      ...(projectDir !== undefined ? { projectDir } : {}),
      ...(tools !== undefined ? { requestedTools: tools } : {}),
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
    ...(limit !== undefined ? { limit } : {}),
    add,
    yes,
    dryRun,
  });
}
