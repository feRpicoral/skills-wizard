import { JsonMergeError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { lstatIfExists, readSymlink, sameFile } from './fs.ts';
import { planLine, planSatisfiedLine } from './import-line.ts';
import { ensureArrayValues, type EnsureResult } from './json-merge.ts';
import { planExcludeRegion, planRegion } from './managed-region.ts';
import {
  CHANGED_OUTSIDE,
  conflict,
  type FileActionParams,
  NONE,
  type PlanFileParams,
  type PlannedAction,
  resolveTargetFile,
  writeAction,
} from './safety.ts';
import type { StagedContents } from './staged.ts';
import type { JsonArrayTarget, SymlinkTarget, Target } from './targets.ts';

type JsonArrayEntry = Extract<ManifestEntry, { kind: 'json-array' }>;

interface CreatedShape {
  createdKeys?: number;
  original?: string;
}

function shapeOf({ createdKeys, original }: CreatedShape): CreatedShape {
  return {
    ...(createdKeys === undefined ? {} : { createdKeys }),
    ...(original === undefined ? {} : { original }),
  };
}

interface CreatedShapeParams {
  earlier: JsonArrayEntry | null;
  result: EnsureResult;
}

function createdShape({ earlier, result }: CreatedShapeParams): CreatedShape {
  if (!earlier) return shapeOf(result);
  if (earlier.createdKeys === undefined) {
    return result.createdKeys > 0 ? shapeOf(result) : {};
  }
  return shapeOf(result.createdKeys > earlier.createdKeys ? result : earlier);
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
    const earlier =
      file.existing !== null && previous?.kind === 'json-array'
        ? previous
        : null;
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
        ...createdShape({ earlier, result }),
        ...((earlier ? earlier.wasEmpty : result.wasEmpty)
          ? { wasEmpty: true }
          : {}),
        ...((earlier ? earlier.blankText : result.blankText) !== undefined
          ? { blankText: earlier ? earlier.blankText : result.blankText }
          : {}),
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

async function planFile({
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
  if (!resolved.ok) return resolved.action;
  const { file } = resolved;

  switch (target.kind) {
    case 'region':
      return planRegion({ target, file, previous });
    case 'exclude-region':
      return planExcludeRegion({ target, file, previous });
    case 'line':
      return planLine({ target, file, previous });
    case 'json-array':
      return planJsonArray({ target, file, previous });
  }
}

export interface PlanTargetParams {
  target: Target;
  previous: ManifestEntry | null;
  staged: StagedContents;
  boundary?: string;
}

export async function planTarget({
  target,
  previous,
  staged,
  boundary,
}: PlanTargetParams): Promise<PlannedAction> {
  if (target.kind === 'symlink') {
    return planSymlink(target, previous);
  }
  return planFile({
    target,
    previous,
    staged,
    ...(boundary ? { boundary } : {}),
  });
}
