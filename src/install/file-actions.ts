import { parsePath } from 'dot-prop';

import { JsonMergeError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { sameFile } from './fs.ts';
import { planLine, planSatisfiedLine } from './import-line.ts';
import {
  type EmptyJsonState,
  ensureArrayValues,
  type EnsureResult,
} from './json-merge.ts';
import { planExcludeRegion, planRegion } from './managed-region.ts';
import {
  planMcpJson,
  planMcpToml,
  type SharedMcpJsonState,
} from './mcp-file-actions.ts';
import {
  conflict,
  type FileActionParams,
  type PlanFileParams as BasePlanFileParams,
  type PlannedAction,
  resolveTargetFile,
  writeAction,
} from './safety.ts';
import type { JsonArrayTarget } from './targets.ts';

export type { EmptyJsonState, SharedMcpJsonState };

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

interface PlanJsonArrayParams extends FileActionParams<JsonArrayTarget> {
  emptyJson?: EmptyJsonState;
}

function planJsonArray({
  target,
  file,
  previous,
  emptyJson,
}: PlanJsonArrayParams): PlannedAction {
  try {
    const earlier =
      file.existing !== null && previous?.kind === 'json-array'
        ? previous
        : null;
    const result = ensureArrayValues({
      existing: file.existing,
      keyPath: target.key,
      values: target.values,
      ...(earlier ? { ownedValues: earlier.added } : {}),
    });
    const added = [
      ...new Set([
        ...(earlier?.added ?? []).filter((value) =>
          target.values.includes(value),
        ),
        ...result.added,
      ]),
    ];
    const wasEmpty = earlier
      ? earlier.wasEmpty
      : (emptyJson?.wasEmpty ?? result.wasEmpty);
    const blankText = earlier
      ? earlier.blankText
      : (emptyJson?.blankText ?? result.blankText);
    const shape = createdShape({ earlier, result });
    const effectiveShape =
      !earlier &&
      shape.original === undefined &&
      emptyJson?.rootOriginal !== undefined
        ? {
            createdKeys: parsePath(target.key).length,
            original: emptyJson.rootOriginal,
          }
        : shape;
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
        ...effectiveShape,
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

export interface PlanFileParams extends BasePlanFileParams {
  emptyJson?: EmptyJsonState;
  sharedMcp?: SharedMcpJsonState;
}

export async function planFile({
  target,
  previous,
  emptyJson,
  sharedMcp,
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
      return planJsonArray({ target, file, previous, emptyJson });
    case 'mcp-json':
      return planMcpJson({ target, file, previous, emptyJson, sharedMcp });
    case 'mcp-toml':
      return planMcpToml({ target, file, previous });
  }
}
