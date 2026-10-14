import { parsePath } from 'dot-prop';

import type { ManifestEntry } from '../state/manifest.ts';
import type { EmptyJsonState, SharedMcpJsonState } from './file-actions.ts';
import { realLocation } from './fs.ts';
import type { PlannedAction } from './safety.ts';
import type { Target } from './targets.ts';

function entryDetail(entry: ManifestEntry): string {
  switch (entry.kind) {
    case 'exclude-region':
      return entry.id;
    case 'line':
      return entry.line;
    case 'json-array':
      return entry.key;
    default:
      return '';
  }
}

export async function ownershipKey(
  entry: ManifestEntry,
): Promise<string | null> {
  if (entry.kind === 'symlink') return null;

  const real = await realLocation(entry.path);

  return real === null ? null : `${entry.kind}:${real}:${entryDetail(entry)}`;
}

export async function ownersByRealLocation(
  actions: readonly PlannedAction[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();

  for (const action of actions) {
    if (!action.entry) continue;

    const key = await ownershipKey(action.entry);
    if (key !== null && !owners.has(key)) owners.set(key, action.label);
  }

  return owners;
}

export async function canonicalPath(path: string): Promise<string> {
  return (await realLocation(path)) ?? path;
}

function rootOriginalForEntry(entry: ManifestEntry): string | undefined {
  if (entry.kind === 'json-array') {
    return entry.original !== undefined &&
      entry.createdKeys !== undefined &&
      entry.createdKeys === parsePath(entry.key).length
      ? entry.original
      : undefined;
  }

  if (entry.kind === 'mcp-json') {
    return entry.original !== undefined && entry.createdMcpServers
      ? entry.original
      : undefined;
  }

  return undefined;
}

export function emptyJsonStateForEntry(
  entry: ManifestEntry,
): EmptyJsonState | undefined {
  if (entry.kind !== 'json-array' && entry.kind !== 'mcp-json') {
    return undefined;
  }

  const rootOriginal = rootOriginalForEntry(entry);

  if (!entry.wasEmpty && rootOriginal === undefined) {
    return undefined;
  }

  return {
    ...(entry.wasEmpty ? { wasEmpty: true } : {}),
    ...(entry.blankText !== undefined ? { blankText: entry.blankText } : {}),
    ...(rootOriginal !== undefined ? { rootOriginal } : {}),
  };
}

interface MergeEmptyJsonStateParams {
  current: EmptyJsonState | undefined;
  next: EmptyJsonState;
}

export function mergeEmptyJsonState({
  current,
  next,
}: MergeEmptyJsonStateParams): EmptyJsonState {
  const wasEmpty = current?.wasEmpty ?? next.wasEmpty;
  const blankText = current?.blankText ?? next.blankText;
  const rootOriginal = current?.rootOriginal ?? next.rootOriginal;

  return {
    ...(wasEmpty ? { wasEmpty: true } : {}),
    ...(blankText !== undefined ? { blankText } : {}),
    ...(rootOriginal !== undefined ? { rootOriginal } : {}),
  };
}

export interface CoownedJsonState {
  createdPaths: Set<string>;
  emptyJsonByPath: Map<string, EmptyJsonState>;
  mcpByRealPath: Map<string, SharedMcpJsonState>;
}

export interface InitCoownedJsonStateParams {
  previousEntries: ReadonlyMap<string, ManifestEntry>;
  targets: readonly Target[];
}

export async function initCoownedJsonState({
  previousEntries,
  targets,
}: InitCoownedJsonStateParams): Promise<CoownedJsonState> {
  const createdPaths = new Set<string>();
  const emptyJsonByPath = new Map<string, EmptyJsonState>();
  const mcpByRealPath = new Map<string, SharedMcpJsonState>();

  for (const entry of previousEntries.values()) {
    const real = await canonicalPath(entry.path);

    if ('createdFile' in entry && entry.createdFile) {
      createdPaths.add(entry.path);
      createdPaths.add(real);
    }

    const emptyState = emptyJsonStateForEntry(entry);

    if (emptyState) {
      emptyJsonByPath.set(
        real,
        mergeEmptyJsonState({
          current: emptyJsonByPath.get(real),
          next: emptyState,
        }),
      );
    }

    if (entry.kind === 'mcp-json') {
      const mcpState = mcpByRealPath.get(real) ?? {
        previousOwned: new Set<string>(),
        plannedServers: new Set<string>(),
        stagedServers: new Set<string>(),
      };

      for (const name of entry.servers) {
        mcpState.previousOwned.add(name);
      }

      if (entry.createdMcpServers) {
        mcpState.createdMcpServers = true;
      }

      if (entry.original !== undefined && mcpState.original === undefined) {
        mcpState.original = entry.original;
      }

      mcpByRealPath.set(real, mcpState);
    }
  }

  for (const target of targets) {
    if (target.kind !== 'mcp-json') continue;

    const real = await canonicalPath(target.path);
    const mcpState = mcpByRealPath.get(real) ?? {
      previousOwned: new Set<string>(),
      plannedServers: new Set<string>(),
      stagedServers: new Set<string>(),
    };

    for (const name of Object.keys(target.servers)) {
      mcpState.plannedServers.add(name);
    }

    mcpByRealPath.set(real, mcpState);
  }

  return { createdPaths, emptyJsonByPath, mcpByRealPath };
}

export async function recordPlannedCoownedEntry(
  state: CoownedJsonState,
  action: PlannedAction,
): Promise<void> {
  if (!action.entry) return;

  const entryReal = await canonicalPath(action.writePath ?? action.entry.path);

  if ('createdFile' in action.entry && action.entry.createdFile) {
    state.createdPaths.add(action.entry.path);
    state.createdPaths.add(entryReal);
  }

  const emptyState = emptyJsonStateForEntry(action.entry);

  if (emptyState) {
    state.emptyJsonByPath.set(
      entryReal,
      mergeEmptyJsonState({
        current: state.emptyJsonByPath.get(entryReal),
        next: emptyState,
      }),
    );
  }
}

export async function collectConflictedMcpByReal(
  targetActions: readonly PlannedAction[],
): Promise<Map<string, Set<string>>> {
  const conflictedMcpByReal = new Map<string, Set<string>>();

  for (const action of targetActions) {
    if (action.status === 'conflict' && action.previous?.kind === 'mcp-json') {
      const real = await canonicalPath(action.previous.path);
      const set = conflictedMcpByReal.get(real) ?? new Set<string>();

      for (const name of action.previous.servers) {
        set.add(name);
      }

      conflictedMcpByReal.set(real, set);
    }
  }

  return conflictedMcpByReal;
}

export interface RetainedMcpServersForRemovalParams {
  entry: ManifestEntry;
  laterEntries: readonly ManifestEntry[];
  conflictedMcpByReal: ReadonlyMap<string, ReadonlySet<string>>;
}

export async function retainedMcpServersForRemoval({
  entry,
  laterEntries,
  conflictedMcpByReal,
}: RetainedMcpServersForRemovalParams): Promise<Set<string> | undefined> {
  if (entry.kind !== 'mcp-json') return undefined;

  const real = await canonicalPath(entry.path);
  const retained = new Set(conflictedMcpByReal.get(real) ?? []);

  for (const later of laterEntries) {
    if (later.kind !== 'mcp-json') continue;

    if ((await canonicalPath(later.path)) === real) {
      for (const name of later.servers) {
        retained.add(name);
      }
    }
  }

  return retained;
}

export interface FilterClaudeDeniedValuesParams {
  values: readonly string[];
  allowedServers: ReadonlySet<string>;
}

export function filterClaudeDeniedValues({
  values,
  allowedServers,
}: FilterClaudeDeniedValuesParams): string[] {
  return values.filter((rule) => {
    const match = /^mcp__([^_]+)__/.exec(rule);
    return match?.[1] !== undefined && allowedServers.has(match[1]);
  });
}
