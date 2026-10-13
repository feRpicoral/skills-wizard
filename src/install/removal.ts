import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { readSymlink, resolveIfSymlink, statIfExists } from './fs.ts';
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
  fileKindProblem,
  leftInPlace,
  locationProblem,
  NONE,
  NOTHING_LEFT,
  type PlannedAction,
  REMOVAL_LABEL,
} from './safety.ts';
import { readStaged, type StagedContents } from './staged.ts';

type SymlinkEntry = Extract<ManifestEntry, { kind: 'symlink' }>;
type FileEntry = Exclude<ManifestEntry, SymlinkEntry>;
type RegionEntry = Extract<FileEntry, { kind: 'region' | 'exclude-region' }>;
type LineEntry = Extract<FileEntry, { kind: 'line' }>;
type JsonArrayEntry = Extract<FileEntry, { kind: 'json-array' }>;

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

interface ResolveRemovalFileParams {
  entry: FileEntry;
  staged: StagedContents;
  boundary?: string;
}

async function resolveRemovalFile({
  entry,
  staged,
  boundary,
}: ResolveRemovalFileParams): Promise<PlannedAction | ResolvedRemovalFile> {
  const target = { path: entry.path, label: REMOVAL_LABEL };
  const viaLink = await resolveIfSymlink(entry.path);
  const writePath = viaLink ?? entry.path;
  const effectiveBoundary =
    entry.kind === 'exclude-region' ? undefined : boundary;
  const problem = await locationProblem({
    path: writePath,
    ...(effectiveBoundary ? { boundary: effectiveBoundary } : {}),
  });
  if (problem) {
    return conflict({
      target,
      previous: entry,
      reason: leftInPlace(problem),
    });
  }
  const kindProblem = fileKindProblem(await statIfExists(writePath));
  if (kindProblem) {
    return conflict({ target, previous: entry, reason: kindProblem });
  }
  const { current: existing } = await readStaged({ staged, path: writePath });
  if (existing === null) {
    return removal({ entry, change: NONE, reason: 'already gone' });
  }
  return { writePath, existing, viaLink: viaLink !== null };
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
    return rewriteOrDelete({
      entry,
      file,
      next: preamble && remaining.trim() === preamble ? '' : remaining,
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
    const next = removeArrayValues({
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
    });
    if (next === file.existing) {
      return removal({ entry, change: NONE, reason: NOTHING_LEFT });
    }
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

export interface PlanRemovalParams {
  entry: ManifestEntry;
  staged: StagedContents;
  sharedWith?: string;
  boundary?: string;
}

export async function planRemoval({
  entry,
  staged,
  sharedWith,
  boundary,
}: PlanRemovalParams): Promise<PlannedAction> {
  if (sharedWith !== undefined) {
    return removal({
      entry,
      change: NONE,
      reason: `the same file is still used for ${sharedWith}`,
    });
  }
  if (entry.kind === 'symlink') {
    return planSymlinkRemoval(entry);
  }
  const resolved = await resolveRemovalFile({
    entry,
    staged,
    ...(boundary ? { boundary } : {}),
  });
  if ('status' in resolved) return resolved;

  switch (entry.kind) {
    case 'region':
    case 'exclude-region':
      return planRegionRemoval(entry, resolved);
    case 'line':
      return planLineRemoval(entry, resolved);
    case 'json-array':
      return planJsonArrayRemoval(entry, resolved);
  }
}
