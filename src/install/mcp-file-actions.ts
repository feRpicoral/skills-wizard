import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import { ensureMcpJsonServers, upsertMcpTomlServers } from '../mcp/install.ts';
import type { EmptyJsonState } from './json-merge.ts';
import {
  conflict,
  type FileActionParams,
  type PlannedAction,
  writeAction,
} from './safety.ts';
import type { McpJsonTarget, McpTomlTarget } from './targets.ts';

export interface SharedMcpJsonState {
  previousOwned: Set<string>;
  plannedServers: Set<string>;
  stagedServers: Set<string>;
  createdMcpServers?: boolean;
  original?: string;
}

export interface PlanMcpJsonParams extends FileActionParams<McpJsonTarget> {
  emptyJson?: EmptyJsonState;
  sharedMcp?: SharedMcpJsonState;
}

/**
 * Plans an `mcp-json` target action while preserving provenance across
 * co-owned JSON files (`emptyJson` for shared settings files such as
 * `.gemini/settings.json` and `sharedMcp` for symlinked MCP configs).
 *
 * Combines previously owned servers (`earlier.servers`,
 * `sharedMcp.previousOwned`, and `sharedMcp.stagedServers`) and protects
 * servers planned or staged by sibling targets (`retainedServers`) before
 * delegating to {@link ensureMcpJsonServers}.
 */
export function planMcpJson({
  target,
  file,
  previous,
  emptyJson,
  sharedMcp,
}: PlanMcpJsonParams): PlannedAction {
  try {
    const earlier =
      file.existing !== null && previous?.kind === 'mcp-json' ? previous : null;
    const ownedServers = [
      ...new Set([
        ...(earlier?.servers ?? []),
        ...(sharedMcp?.previousOwned ?? []),
        ...(sharedMcp?.stagedServers ?? []),
      ]),
    ];
    const retainedServers = new Set<string>([
      ...(sharedMcp?.stagedServers ?? []),
      ...(sharedMcp?.plannedServers ?? []),
    ]);
    const result = ensureMcpJsonServers({
      existing: file.existing,
      servers: target.servers,
      ownedServers,
      retainedServers,
    });
    const createdMcpServers =
      Boolean(earlier?.createdMcpServers) ||
      Boolean(sharedMcp?.createdMcpServers) ||
      result.createdMcpServers;
    const original = earlier
      ? earlier.original
      : (result.original ??
        sharedMcp?.original ??
        (createdMcpServers ? emptyJson?.rootOriginal : undefined));
    const wasEmpty = earlier
      ? earlier.wasEmpty
      : (emptyJson?.wasEmpty ?? result.wasEmpty);
    const blankText = earlier
      ? earlier.blankText
      : (emptyJson?.blankText ?? result.blankText);
    if (sharedMcp) {
      for (const name of result.servers) {
        sharedMcp.stagedServers.add(name);
      }
      if (createdMcpServers) {
        sharedMcp.createdMcpServers = true;
      }
      if (original !== undefined && sharedMcp.original === undefined) {
        sharedMcp.original = original;
      }
    }
    return writeAction({
      target,
      file,
      next: result.content,
      entry: {
        kind: 'mcp-json',
        path: target.path,
        servers: result.servers,
        ...(createdMcpServers ? { createdMcpServers: true } : {}),
        ...(original !== undefined ? { original } : {}),
        ...(wasEmpty ? { wasEmpty: true } : {}),
        ...(blankText !== undefined ? { blankText } : {}),
        createdFile: file.createdFile,
      },
      previous,
    });
  } catch (error) {
    if (error instanceof JsonMergeError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}

export function planMcpToml({
  target,
  file,
  previous,
}: FileActionParams<McpTomlTarget>): PlannedAction {
  try {
    const next = upsertMcpTomlServers({
      existing: file.existing,
      body: target.body,
      serverNames: target.serverNames,
    });
    return writeAction({
      target,
      file,
      next,
      entry: {
        kind: 'mcp-toml',
        path: target.path,
        servers: [...target.serverNames],
        createdFile: file.createdFile,
      },
      previous,
    });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}
