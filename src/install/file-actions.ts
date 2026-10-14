import type { ManifestEntry } from '../state/manifest.ts';
import { lstatIfExists, readSymlink } from './fs.ts';
import { planLine, planSatisfiedLine } from './import-line.ts';
import { planJsonArray } from './json-merge.ts';
import { planExcludeRegion, planRegion } from './managed-region.ts';
import {
  CHANGED_OUTSIDE,
  conflict,
  type FileActionParams,
  NONE,
  type PlanFileParams,
  type PlannedAction,
  type ResolvedTargetFile,
  resolveTargetFile,
  sameFile,
  wasCreated,
  writeAction,
} from './safety.ts';
import type { StagedContents } from './staged.ts';
import type { SymlinkTarget, Target } from './targets.ts';

export type { FileActionParams, PlanFileParams, ResolvedTargetFile };
export { resolveTargetFile, wasCreated, writeAction };

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
