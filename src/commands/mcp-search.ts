import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { isSystemError, McpError, UsageError } from '../errors.ts';
import { fsErrorReason } from '../install/fs.ts';
import {
  appendMcpServers,
  extendMcpCatalog,
  findMcpServer,
  formatMcpServerYaml,
  type McpCatalog,
  mcpCatalogPath,
  type McpServerDefinition,
} from '../mcp/model.ts';
import { type McpSearchCandidate, searchMcpRegistry } from '../mcp/search.ts';
import {
  confirmApply,
  promptMcpSearchCandidate,
} from '../prompts/selection.ts';
import { notify } from './shared.ts';

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

export interface AddCandidateToMcpCatalogParams {
  ctx: Context;
  prompting: boolean;
  catalog: McpCatalog;
  chosen: McpSearchCandidate;
  yes: boolean;
  dryRun: boolean;
}

export async function addCandidateToMcpCatalog({
  ctx,
  prompting,
  catalog,
  chosen,
  yes,
  dryRun,
}: AddCandidateToMcpCatalogParams): Promise<number> {
  if (findMcpServer(catalog, chosen.server.name)) {
    throw new UsageError(
      `MCP server "${chosen.server.name}" is already in mcp/servers.yaml; run agents-config mcp add ${chosen.server.name} to install it.`,
    );
  }

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
  const summary = `Added to mcp/servers.yaml: ${chosen.server.name}`;
  if (prompting) clack.outro(summary);
  else ctx.print(summary);
  return 0;
}

export interface RunMcpSearchParams {
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

export async function runMcpSearch({
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
    baseUrl: ctx.sources.mcpRegistryUrl,
    limit,
    fetchFn: ctx.sources.fetch,
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

  return addCandidateToMcpCatalog({
    ctx,
    prompting,
    catalog,
    chosen,
    yes,
    dryRun,
  });
}
