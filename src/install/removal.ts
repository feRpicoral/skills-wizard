import { dirname } from 'node:path';

import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import { removeMcpJsonServers, removeMcpTomlServers } from '../mcp/install.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { readSymlink } from './fs.ts';
import { removeLine } from './import-line.ts';
import {
  isEmptyJsonObject,
  legacyCreatedKeys,
  removeArrayValues,
} from './json-merge.ts';
import {
  excludeMarkers,
  MARKDOWN_MARKERS,
  removeRegion,
} from './managed-region.ts';
import {
  type Change,
  CHANGED_OUTSIDE,
  conflict,
  inspectTargetFile,
  leftInPlace,
  locationProblem,
  NONE,
  NOTHING_LEFT,
  type PlannedAction,
  REMOVAL_LABEL,
} from './safety.ts';
import {
  installedState,
  SHARED_FOLDER,
  sharesSkillsFolder,
  type SkillEntry,
} from './skill-actions.ts';
import type { StagedContents } from './staged.ts';

type SymlinkEntry = Extract<ManifestEntry, { kind: 'symlink' }>;
type FileEntry = Exclude<ManifestEntry, SymlinkEntry | SkillEntry>;
type RegionEntry = Extract<FileEntry, { kind: 'region' | 'exclude-region' }>;
type LineEntry = Extract<FileEntry, { kind: 'line' }>;
type JsonArrayEntry = Extract<FileEntry, { kind: 'json-array' }>;
type McpJsonEntry = Extract<FileEntry, { kind: 'mcp-json' }>;
type McpTomlEntry = Extract<FileEntry, { kind: 'mcp-toml' }>;

interface ResolvedRemovalFile {
  writePath: string;
  existing: string;
  viaLink: boolean;
}

interface RemovalActionParams {
  entry: ManifestEntry;
  change: Change;
  writePath?: string;
  reason?: string;
}

function removal({
  entry,
  change,
  writePath,
  reason,
}: RemovalActionParams): PlannedAction {
  const untouched = change.type === 'none';
  return {
    path: entry.path,
    ...(writePath ? { writePath } : {}),
    label: untouched ? 'no longer tracked' : REMOVAL_LABEL,
    status: untouched ? 'unchanged' : 'remove',
    change,
    entry: null,
    previous: entry,
    ...(reason ? { reason } : {}),
  };
}

interface RewriteOrDeleteParams {
  entry: FileEntry;
  file: ResolvedRemovalFile;
  next: string;
  emptyWhen: (next: string) => boolean;
}

function rewriteOrDelete({
  entry,
  file,
  next,
  emptyWhen,
}: RewriteOrDeleteParams): PlannedAction {
  const writePath = file.viaLink ? { writePath: file.writePath } : {};
  if (entry.createdFile && !file.viaLink && emptyWhen(next)) {
    return removal({ entry, change: { type: 'delete' } });
  }
  if (next === file.existing) {
    return removal({
      entry,
      change: NONE,
      ...writePath,
      reason: NOTHING_LEFT,
    });
  }
  return removal({
    entry,
    change: { type: 'write', content: next },
    ...writePath,
  });
}

async function planSymlinkRemoval(entry: SymlinkEntry): Promise<PlannedAction> {
  if ((await readSymlink(entry.path)) === entry.target) {
    return removal({ entry, change: { type: 'delete' } });
  }
  return removal({ entry, change: NONE, reason: CHANGED_OUTSIDE });
}

async function planSkillRemoval(entry: SkillEntry): Promise<PlannedAction> {
  const state = await installedState(entry.path, entry);
  if (state === 'missing') {
    return removal({ entry, change: NONE, reason: 'already gone' });
  }
  if (state !== 'owned') {
    return removal({ entry, change: NONE, reason: CHANGED_OUTSIDE });
  }
  return removal({ entry, change: { type: 'delete-tree' } });
}

interface ResolveRemovalFileParams {
  entry: FileEntry;
  staged: StagedContents;
  boundary?: string;
}

type ResolvedRemovalOutcome =
  | { ok: true; file: ResolvedRemovalFile }
  | { ok: false; action: PlannedAction };

async function resolveRemovalFile({
  entry,
  staged,
  boundary,
}: ResolveRemovalFileParams): Promise<ResolvedRemovalOutcome> {
  const inspection = await inspectTargetFile({
    target: { path: entry.path, label: REMOVAL_LABEL, kind: entry.kind },
    previous: entry,
    staged,
    boundary,
  });
  if (!inspection.ok) return inspection;
  if (inspection.current === null) {
    return {
      ok: false,
      action: removal({ entry, change: NONE, reason: 'already gone' }),
    };
  }
  return {
    ok: true,
    file: {
      writePath: inspection.writePath,
      existing: inspection.current,
      viaLink: inspection.viaLink,
    },
  };
}

function planRegionRemoval(
  entry: RegionEntry,
  file: ResolvedRemovalFile,
): PlannedAction {
  try {
    const markers =
      entry.kind === 'region' ? MARKDOWN_MARKERS : excludeMarkers(entry.id);
    const preamble = entry.kind === 'region' ? entry.preamble : undefined;
    const remaining = removeRegion(file.existing, markers);
    // Through a link the file is not the CLI's, so a heading it once wrote stays.
    const strip = preamble && !file.viaLink && remaining.trim() === preamble;
    return rewriteOrDelete({
      entry,
      file,
      next: strip ? '' : remaining,
      emptyWhen: (next) => next === '',
    });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({
        target: { path: entry.path, label: REMOVAL_LABEL },
        previous: entry,
        reason: error.message,
      });
    }
    throw error;
  }
}

function planLineRemoval(
  entry: LineEntry,
  file: ResolvedRemovalFile,
): PlannedAction {
  if (!entry.added) {
    return removal({
      entry,
      change: NONE,
      reason: 'the line was there before agents-config',
    });
  }
  return rewriteOrDelete({
    entry,
    file,
    next: removeLine({ existing: file.existing, line: entry.line }),
    emptyWhen: (next) => next === '',
  });
}

function planJsonArrayRemoval(
  entry: JsonArrayEntry,
  file: ResolvedRemovalFile,
): PlannedAction {
  try {
    const removed = removeArrayValues({
      existing: file.existing,
      keyPath: entry.key,
      values: entry.added,
      restoreString: entry.wasString,
      createdKeys:
        entry.createdKeys ??
        legacyCreatedKeys({
          keyPath: entry.key,
          createdFile: entry.createdFile,
        }),
      ...(entry.original === undefined ? {} : { original: entry.original }),
    });
    const next =
      entry.wasEmpty && isEmptyJsonObject(removed)
        ? (entry.blankText ?? '')
        : removed;
    return rewriteOrDelete({ entry, file, next, emptyWhen: isEmptyJsonObject });
  } catch (error) {
    if (error instanceof JsonMergeError) {
      return conflict({
        target: { path: entry.path, label: REMOVAL_LABEL },
        previous: entry,
        reason: error.message,
      });
    }
    throw error;
  }
}

interface PlanMcpJsonRemovalParams {
  entry: McpJsonEntry;
  file: ResolvedRemovalFile;
  retainedServers?: ReadonlySet<string>;
}

function planMcpJsonRemoval({
  entry,
  file,
  retainedServers,
}: PlanMcpJsonRemovalParams): PlannedAction {
  try {
    const removed = removeMcpJsonServers({
      existing: file.existing,
      servers: entry.servers,
      createdMcpServers: entry.createdMcpServers ?? entry.createdFile,
      ...(entry.original === undefined ? {} : { original: entry.original }),
      ...(retainedServers !== undefined ? { retainedServers } : {}),
    });
    const next =
      entry.wasEmpty && isEmptyJsonObject(removed)
        ? (entry.blankText ?? '')
        : removed;
    return rewriteOrDelete({ entry, file, next, emptyWhen: isEmptyJsonObject });
  } catch (error) {
    if (error instanceof JsonMergeError) {
      return conflict({
        target: { path: entry.path, label: REMOVAL_LABEL },
        previous: entry,
        reason: error.message,
      });
    }
    throw error;
  }
}

function planMcpTomlRemoval(
  entry: McpTomlEntry,
  file: ResolvedRemovalFile,
): PlannedAction {
  try {
    const remaining = removeMcpTomlServers(file.existing);
    return rewriteOrDelete({
      entry,
      file,
      next: remaining,
      emptyWhen: (next) => next === '',
    });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({
        target: { path: entry.path, label: REMOVAL_LABEL },
        previous: entry,
        reason: error.message,
      });
    }
    throw error;
  }
}

export interface PlanRemovalParams {
  entry: ManifestEntry;
  staged: StagedContents;
  sharedWith?: string;
  boundary?: string;
  retainedMcpServers?: ReadonlySet<string>;
}

export async function planRemoval({
  entry,
  staged,
  sharedWith,
  boundary,
  retainedMcpServers,
}: PlanRemovalParams): Promise<PlannedAction> {
  if (sharedWith !== undefined) {
    return removal({
      entry,
      change: NONE,
      reason: `the same file is still used for ${sharedWith}`,
    });
  }
  if (entry.kind === 'symlink' || entry.kind === 'skill') {
    if (boundary !== undefined) {
      const problem = await locationProblem({
        path: dirname(entry.path),
        boundary,
      });
      if (problem) {
        return conflict({
          target: { path: entry.path, label: REMOVAL_LABEL },
          previous: entry,
          reason: leftInPlace(problem),
        });
      }
    }
    if (entry.kind === 'skill') return planSkillRemoval(entry);
    if (await sharesSkillsFolder(entry)) {
      return removal({ entry, change: NONE, reason: SHARED_FOLDER });
    }
    return planSymlinkRemoval(entry);
  }
  const resolved = await resolveRemovalFile({
    entry,
    staged,
    boundary,
  });
  if (!resolved.ok) return resolved.action;

  switch (entry.kind) {
    case 'region':
    case 'exclude-region':
      return planRegionRemoval(entry, resolved.file);
    case 'line':
      return planLineRemoval(entry, resolved.file);
    case 'json-array':
      return planJsonArrayRemoval(entry, resolved.file);
    case 'mcp-json':
      return planMcpJsonRemoval({
        entry,
        file: resolved.file,
        retainedServers: retainedMcpServers,
      });
    case 'mcp-toml':
      return planMcpTomlRemoval(entry, resolved.file);
  }
}
