import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import {
  allServerSecrets,
  type McpCatalog,
  outOfScopeMcpServerNames,
  requiredServerSecrets,
  selectMcpServers,
  unknownMcpServerNames,
} from '../mcp/model.ts';
import type { Manifest } from '../state/manifest.ts';
import type { Finding } from './doctor-checks.ts';
import { loadMcpServers } from './shared.ts';

export interface ResolvedDoctorMcp {
  mcpCatalog: McpCatalog;
  mcp: string[];
  findings: Finding[];
}

export async function resolveDoctorMcp(
  ctx: Context,
  manifest: Manifest,
  scope: Scope,
): Promise<ResolvedDoctorMcp> {
  const findings: Finding[] = [];
  const mcpCatalog = await loadMcpServers(ctx);
  const recorded = manifest.mcp ?? [];

  const unknownMcp = unknownMcpServerNames(mcpCatalog, recorded);

  if (unknownMcp.length > 0) {
    findings.push({
      level: 'warn',
      message: `MCP servers no longer in mcp/servers.yaml: ${unknownMcp.join(', ')}; skills-wizard sync will remove them`,
    });
  }

  const outOfScopeMcp = outOfScopeMcpServerNames({
    catalog: mcpCatalog,
    names: recorded,
    scope,
  });

  if (outOfScopeMcp.length > 0) {
    findings.push({
      level: 'warn',
      message: `MCP servers no longer available for ${scope} scope: ${outOfScopeMcp.join(', ')}; skills-wizard sync will remove them`,
    });
  }

  const mcp = recorded.filter(
    (name) => !unknownMcp.includes(name) && !outOfScopeMcp.includes(name),
  );

  return { mcpCatalog, mcp, findings };
}

export interface McpFindingsParams {
  ctx: Context;
  scope: Scope;
  manifest: Manifest;
  mcpCatalog: McpCatalog;
  mcp: readonly string[];
}

export function mcpFindings({
  ctx,
  scope,
  manifest,
  mcpCatalog,
  mcp,
}: McpFindingsParams): Finding[] {
  if (mcp.length === 0 || manifest.tools.length === 0) return [];

  const findings: Finding[] = [];
  const tools = new Set(manifest.tools);
  const usesAntigravity =
    tools.has('antigravity') || tools.has('antigravity-cli');
  const usesClaudeCode = tools.has('claude-code');
  const usesCodex = tools.has('codex');
  const usesGeminiCli = tools.has('gemini-cli');
  const servers = selectMcpServers({
    catalog: mcpCatalog,
    names: mcp,
    scope,
  });

  for (const server of servers) {
    const missingSecrets = requiredServerSecrets(server).filter(
      (secret) => !(ctx.hasEnvVar?.(secret) ?? false),
    );

    if (missingSecrets.length > 0) {
      findings.push({
        level: 'warn',
        message: `MCP server "${server.name}" requires unset environment variable${missingSecrets.length === 1 ? '' : 's'}: ${missingSecrets.join(', ')}`,
      });
    }
  }

  if (usesAntigravity) {
    const stdioSecretServers = servers.filter(
      (server) =>
        server.transport === 'stdio' && allServerSecrets(server).length > 0,
    );

    if (stdioSecretServers.length > 0) {
      const names = stdioSecretServers.map((server) => server.name).join(', ');
      findings.push({
        level: 'note',
        message: `Antigravity stdio MCP server${stdioSecretServers.length === 1 ? '' : 's'} (${names}) read secret environment variables from the process environment; launching Antigravity from the macOS Dock may not inherit shell variables unless launched from a terminal or configured via launchctl`,
      });
    }
  }

  if (scope === 'project') {
    if (usesClaudeCode) {
      findings.push({
        level: 'note',
        message:
          'Claude Code requires interactive project approval before loading MCP servers from .mcp.json',
      });
    }

    if (usesCodex) {
      findings.push({
        level: 'note',
        message:
          'Codex loads project .codex/config.toml MCP servers only after the project is marked trusted',
      });
    }

    if (usesGeminiCli) {
      findings.push({
        level: 'note',
        message:
          'Gemini CLI loads project .gemini/settings.json MCP servers only in trusted folders',
      });
    }
  }

  if (usesGeminiCli) {
    const hasEstimates = servers.some(
      (server) => server.estimatedTools !== undefined,
    );
    const totalTools = servers.reduce(
      (sum, server) => sum + (server.estimatedTools ?? 0),
      0,
    );
    const serverCountLabel = `${servers.length} server${servers.length === 1 ? '' : 's'}`;
    const detail =
      hasEstimates && totalTools > 0
        ? `~${totalTools} estimated tool${totalTools === 1 ? '' : 's'} across ${serverCountLabel}`
        : serverCountLabel;

    findings.push({
      level: 'note',
      message: `Gemini CLI loads all MCP tool schemas into context up front (${detail})`,
    });
  }

  return findings;
}
