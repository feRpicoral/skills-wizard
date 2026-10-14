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

/**
 * Reads `path` as it exists after earlier actions in the same plan (`current`)
 * alongside its raw on-disk text (`onDisk`).
 *
 * Looks `path` up by its canonical `realLocation` so multiple targets that
 * resolve through symlinks to the same underlying file see each other's staged
 * writes. Deletions are staged under the deleted path itself; a link deleted in
 * the plan is never read through afterwards because deletions only happen in
 * the removal phase, after every target action has been planned.
 */
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

/**
 * Records the effect of `action` in `staged` keyed by canonical `realLocation`
 * so subsequent actions in the same plan observe in-flight writes and deletes.
 */
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
