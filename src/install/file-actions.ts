import { planLine, planSatisfiedLine } from './import-line.ts';
import { type EmptyJsonState, planJsonArray } from './json-merge.ts';
import { planExcludeRegion, planRegion } from './managed-region.ts';
import {
  planMcpJson,
  planMcpToml,
  type SharedMcpJsonState,
} from './mcp-file-actions.ts';
import {
  type FileActionParams,
  type PlanFileParams as BasePlanFileParams,
  type PlannedAction,
  type ResolvedTargetFile,
  resolveTargetFile,
  sameFile,
  wasCreated,
  writeAction,
} from './safety.ts';

export type {
  EmptyJsonState,
  FileActionParams,
  ResolvedTargetFile,
  SharedMcpJsonState,
};
export { resolveTargetFile, wasCreated, writeAction };

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

  const emptyState = emptyJson ? { emptyJson } : {};
  const mcpState = sharedMcp ? { sharedMcp } : {};
  switch (target.kind) {
    case 'region':
      return planRegion({ target, file, previous });
    case 'exclude-region':
      return planExcludeRegion({ target, file, previous });
    case 'line':
      return planLine({ target, file, previous });
    case 'json-array':
      return planJsonArray({ target, file, previous, ...emptyState });
    case 'mcp-json':
      return planMcpJson({
        target,
        file,
        previous,
        ...emptyState,
        ...mcpState,
      });
    case 'mcp-toml':
      return planMcpToml({ target, file, previous });
  }
}
