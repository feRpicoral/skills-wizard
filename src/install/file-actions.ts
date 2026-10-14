import { planLine, planSatisfiedLine } from './import-line.ts';
import { planJsonArray } from './json-merge.ts';
import { planExcludeRegion, planRegion } from './managed-region.ts';
import {
  type FileActionParams,
  type PlanFileParams,
  type PlannedAction,
  type ResolvedTargetFile,
  resolveTargetFile,
  sameFile,
  wasCreated,
  writeAction,
} from './safety.ts';

export type { FileActionParams, PlanFileParams, ResolvedTargetFile };
export { resolveTargetFile, wasCreated, writeAction };

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
