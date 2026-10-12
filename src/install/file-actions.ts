import { basename } from 'node:path';

import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import {
  lstatIfExists,
  readSymlink,
  readTextIfExists,
  resolveIfSymlink,
  statIfExists,
} from './fs.ts';
import { ensureLine, hasLine } from './import-line.ts';
import {
  ensureArrayValues,
  parseJsonObject,
  serializeJson,
} from './json-merge.ts';
import {
  excludeMarkers,
  MARKDOWN_MARKERS,
  upsertRegion,
} from './managed-region.ts';
import {
  CHANGED_OUTSIDE,
  conflict,
  fileKindProblem,
  leftInPlace,
  linksTo,
  locationProblem,
  NONE,
  type PlannedAction,
  type TargetLabel,
} from './safety.ts';
import type {
  ExcludeRegionTarget,
  FileTarget,
  JsonArrayTarget,
  LineTarget,
  RegionTarget,
  SymlinkTarget,
  Target,
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

async function planSymlink(
  target: SymlinkTarget,
  previous: ManifestEntry | null,
): Promise<PlannedAction> {
  const stats = await lstatIfExists(target.path);
  const current = await readSymlink(target.path);
  const entry: ManifestEntry = {
    kind: 'symlink',
    path: target.path,
    target: target.target,
  };
  const base = { path: target.path, label: target.label, entry, previous };

  if (current === target.target) {
    return { ...base, status: 'unchanged', change: NONE };
  }
  if (!stats) {
    return {
      ...base,
      status: 'create',
      change: { type: 'symlink', target: target.target },
    };
  }
  if (previous?.kind === 'symlink' && current === previous.target) {
    return {
      ...base,
      status: 'update',
      change: { type: 'symlink', target: target.target },
    };
  }
  return conflict({
    target,
    previous,
    reason: previous
      ? CHANGED_OUTSIDE
      : 'exists and is not managed by agents-config',
  });
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
  if (existing === null) return target.preamble;
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
      doc: parseJsonObject(file.existing),
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
    const next =
      file.existing === null || result.added.length > 0
        ? serializeJson(result.doc, file.existing)
        : file.existing;
    return writeAction({
      target,
      file,
      next,
      entry: {
        kind: 'json-array',
        path: target.path,
        key: target.key,
        added,
        wasString: earlier?.wasString ?? result.wasString,
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

interface PlanFileParams {
  target: FileTarget;
  previous: ManifestEntry | null;
  boundary?: string;
}

async function resolveTargetFile({
  target,
  previous,
  boundary,
}: PlanFileParams): Promise<PlannedAction | ResolvedTargetFile> {
  let writePath = target.path;
  const stats = await lstatIfExists(target.path);
  if (stats?.isSymbolicLink()) {
    if (
      target.kind === 'line' &&
      target.satisfiedBy &&
      (await linksTo({ link: target.path, destination: target.satisfiedBy }))
    ) {
      return {
        path: target.path,
        label: `${target.label} (links to ${basename(target.satisfiedBy)})`,
        status: 'unchanged',
        change: NONE,
        entry: null,
        previous,
      };
    }
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

  const existing = await readTextIfExists(writePath);
  return {
    writePath,
    existing,
    createdFile: wasCreated(existing, previous),
  };
}

async function planFile(params: PlanFileParams): Promise<PlannedAction> {
  const resolved = await resolveTargetFile(params);
  if ('status' in resolved) return resolved;

  const { target, previous } = params;
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

export interface PlanTargetParams {
  target: Target;
  previous: ManifestEntry | null;
  boundary?: string;
}

export async function planTarget({
  target,
  previous,
  boundary,
}: PlanTargetParams): Promise<PlannedAction> {
  if (target.kind === 'symlink') {
    return planSymlink(target, previous);
  }
  return planFile({
    target,
    previous,
    ...(boundary ? { boundary } : {}),
  });
}
