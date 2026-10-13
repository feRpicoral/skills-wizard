import { basename } from 'node:path';

import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { lstatIfExists, resolveIfSymlink, statIfExists } from './fs.ts';
import { ensureLine, hasLine, removeLine } from './import-line.ts';
import { ensureArrayValues, LEGACY_CREATED_KEYS } from './json-merge.ts';
import { isBlank } from './lines.ts';
import {
  excludeMarkers,
  MARKDOWN_MARKERS,
  upsertRegion,
} from './managed-region.ts';
import {
  conflict,
  fileKindProblem,
  leftInPlace,
  locationProblem,
  NONE,
  type PlannedAction,
  sameFile,
  type TargetLabel,
} from './safety.ts';
import { readStaged, type StagedContents } from './staged.ts';
import type {
  ExcludeRegionTarget,
  FileTarget,
  JsonArrayTarget,
  LineTarget,
  RegionTarget,
} from './targets.ts';

interface ResolvedTargetFile {
  writePath: string;
  existing: string | null;
  createdFile: boolean;
}

interface WriteActionParams {
  target: TargetLabel;
  file: ResolvedTargetFile;
  next: string;
  entry: ManifestEntry;
  previous: ManifestEntry | null;
}

function writeAction({
  target,
  file,
  next,
  entry,
  previous,
}: WriteActionParams): PlannedAction {
  const status =
    file.existing === null
      ? 'create'
      : next === file.existing
        ? 'unchanged'
        : 'update';
  return {
    path: target.path,
    ...(file.writePath !== target.path ? { writePath: file.writePath } : {}),
    label: target.label,
    status,
    change: status === 'unchanged' ? NONE : { type: 'write', content: next },
    entry,
    previous,
  };
}

function wasCreated(
  existing: string | null,
  previous: ManifestEntry | null,
): boolean {
  if (existing === null) return true;
  return previous !== null && 'createdFile' in previous
    ? previous.createdFile
    : false;
}

interface RegionPreambleParams {
  target: RegionTarget;
  existing: string | null;
  previous: ManifestEntry | null;
}

function regionPreamble({
  target,
  existing,
  previous,
}: RegionPreambleParams): string | undefined {
  if (isBlank(existing)) return target.preamble;
  return previous?.kind === 'region' ? previous.preamble : undefined;
}

interface FileActionParams<T extends FileTarget> {
  target: T;
  file: ResolvedTargetFile;
  previous: ManifestEntry | null;
}

function planRegion({
  target,
  file,
  previous,
}: FileActionParams<RegionTarget>): PlannedAction {
  try {
    const next = upsertRegion({
      existing: file.existing,
      body: target.body,
      markers: MARKDOWN_MARKERS,
      ...(target.preamble ? { preamble: target.preamble } : {}),
    });
    const preamble = regionPreamble({
      target,
      existing: file.existing,
      previous,
    });
    const entry: ManifestEntry = {
      kind: 'region',
      path: target.path,
      createdFile: file.createdFile,
      ...(preamble ? { preamble } : {}),
    };
    return writeAction({ target, file, next, entry, previous });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}

function planExcludeRegion({
  target,
  file,
  previous,
}: FileActionParams<ExcludeRegionTarget>): PlannedAction {
  try {
    const next = upsertRegion({
      existing: file.existing,
      body: target.body,
      markers: excludeMarkers(target.id),
    });
    const entry: ManifestEntry = {
      kind: 'exclude-region',
      path: target.path,
      id: target.id,
      createdFile: file.createdFile,
    };
    return writeAction({ target, file, next, entry, previous });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}

function planLine({
  target,
  file,
  previous,
}: FileActionParams<LineTarget>): PlannedAction {
  const hadLine =
    file.existing !== null &&
    hasLine({ content: file.existing, line: target.line });
  const added = hadLine ? previous?.kind === 'line' && previous.added : true;
  return writeAction({
    target,
    file,
    next: ensureLine({ existing: file.existing, line: target.line }),
    entry: {
      kind: 'line',
      path: target.path,
      line: target.line,
      added,
      createdFile: file.createdFile,
    },
    previous,
  });
}

function planJsonArray({
  target,
  file,
  previous,
}: FileActionParams<JsonArrayTarget>): PlannedAction {
  try {
    const result = ensureArrayValues({
      existing: file.existing,
      keyPath: target.key,
      values: target.values,
    });
    const earlier = previous?.kind === 'json-array' ? previous : null;
    const added = [
      ...new Set([
        ...(earlier?.added ?? []).filter((value) =>
          target.values.includes(value),
        ),
        ...result.added,
      ]),
    ];
    return writeAction({
      target,
      file,
      next: result.content,
      entry: {
        kind: 'json-array',
        path: target.path,
        key: target.key,
        added,
        wasString: earlier?.wasString ?? result.wasString,
        createdKeys: Math.max(
          earlier ? (earlier.createdKeys ?? LEGACY_CREATED_KEYS) : 0,
          result.createdKeys,
        ),
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

export interface PlanFileParams {
  target: FileTarget;
  previous: ManifestEntry | null;
  staged: StagedContents;
  boundary?: string;
}

async function resolveTargetFile({
  target,
  previous,
  staged,
  boundary,
}: PlanFileParams): Promise<PlannedAction | ResolvedTargetFile> {
  let writePath = target.path;
  const stats = await lstatIfExists(target.path);
  if (stats?.isSymbolicLink()) {
    const resolved = await resolveIfSymlink(target.path);
    if (resolved === null) {
      return conflict({
        target,
        previous,
        reason: 'is a symlink to a missing file',
      });
    }
    writePath = resolved;
  }

  const effectiveBoundary =
    target.kind === 'exclude-region' ? undefined : boundary;
  const problem = await locationProblem({
    path: writePath,
    ...(effectiveBoundary ? { boundary: effectiveBoundary } : {}),
  });
  if (problem) {
    return conflict({ target, previous, reason: leftInPlace(problem) });
  }
  const kindProblem = fileKindProblem(await statIfExists(writePath));
  if (kindProblem) {
    return conflict({ target, previous, reason: kindProblem });
  }

  const { current, onDisk } = await readStaged({ staged, path: writePath });
  return {
    writePath,
    existing: current,
    createdFile: wasCreated(onDisk, previous),
  };
}

interface PlanSatisfiedLineParams extends PlanFileParams {
  target: LineTarget;
  satisfiedBy: string;
}

async function planSatisfiedLine({
  target,
  previous,
  satisfiedBy,
  ...rest
}: PlanSatisfiedLineParams): Promise<PlannedAction> {
  const label = `${target.label} (links to ${basename(satisfiedBy)})`;
  const unchanged: PlannedAction = {
    path: target.path,
    label,
    status: 'unchanged',
    change: NONE,
    entry: null,
    previous,
  };
  if (previous?.kind !== 'line' || !previous.added) return unchanged;

  const resolved = await resolveTargetFile({ target, previous, ...rest });
  if ('status' in resolved) return resolved;
  if (
    resolved.existing === null ||
    !hasLine({ content: resolved.existing, line: target.line })
  ) {
    return unchanged;
  }
  return {
    ...unchanged,
    ...(resolved.writePath !== target.path
      ? { writePath: resolved.writePath }
      : {}),
    status: 'update',
    change: {
      type: 'write',
      content: removeLine({ existing: resolved.existing, line: target.line }),
    },
    reason: 'removes an import of the file itself',
  };
}

export async function planFile({
  target,
  previous,
  ...rest
}: PlanFileParams): Promise<PlannedAction> {
  if (
    target.kind === 'line' &&
    target.satisfiedBy !== undefined &&
    (await sameFile({ path: target.path, other: target.satisfiedBy }))
  ) {
    return planSatisfiedLine({
      target,
      previous,
      satisfiedBy: target.satisfiedBy,
      ...rest,
    });
  }
  const resolved = await resolveTargetFile({ target, previous, ...rest });
  if ('status' in resolved) return resolved;

  switch (target.kind) {
    case 'region':
      return planRegion({ target, file: resolved, previous });
    case 'exclude-region':
      return planExcludeRegion({ target, file: resolved, previous });
    case 'line':
      return planLine({ target, file: resolved, previous });
    case 'json-array':
      return planJsonArray({ target, file: resolved, previous });
  }
}
