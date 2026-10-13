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

interface StageActionParams {
  staged: StagedContents;
  action: PlannedAction;
}

export async function stageAction({
  staged,
  action,
}: StageActionParams): Promise<void> {
  const { change } = action;
  if (change.type !== 'write' && change.type !== 'delete') return;
  const location = await realLocation(action.writePath ?? action.path);
  if (location === null) return;
  staged.set(location, change.type === 'write' ? change.content : null);
}
