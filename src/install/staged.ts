import { basename, dirname, join } from 'node:path';

import { readTextIfExists, realLocation } from './fs.ts';
import type { PlannedAction } from './safety.ts';

export type StagedContents = Map<string, string | null>;

interface ReadStagedParams {
  staged: ReadonlyMap<string, string | null>;
  path: string;
}

interface StagedText {
  current: string | null;
  onDisk: string | null;
}

// Looks the path up by its real location, resolving links that are still on
// disk. Callers pass the resolved write path, so a link deleted earlier in the
// plan is never read through; deletions are staged under the deleted path.
export async function readStaged({
  staged,
  path,
}: ReadStagedParams): Promise<StagedText> {
  const onDisk = await readTextIfExists(path);
  const location = await realLocation(path);
  if (location === null || !staged.has(location)) {
    return { current: onDisk, onDisk };
  }
  return { current: staged.get(location) ?? null, onDisk };
}

async function deletedLocation(path: string): Promise<string | null> {
  const parent = await realLocation(dirname(path));
  return parent === null ? null : join(parent, basename(path));
}

interface StageActionParams {
  staged: StagedContents;
  action: PlannedAction;
}

export async function stageAction({
  staged,
  action,
}: StageActionParams): Promise<void> {
  const { change } = action;
  if (change.type === 'write') {
    const location = await realLocation(action.writePath ?? action.path);
    if (location !== null) staged.set(location, change.content);
  } else if (change.type === 'delete') {
    const location = await deletedLocation(action.path);
    if (location !== null) staged.set(location, null);
  }
}
