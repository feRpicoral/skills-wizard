import { ManifestError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import {
  fileKindProblem,
  fsErrorReason,
  isInside,
  lstatIfExists,
  realLocation,
  resolveIfSymlink,
  statIfExists,
} from './fs.ts';
import { readStaged, type StagedContents } from './staged.ts';
import type { FileTarget } from './targets.ts';

export type ActionStatus =
  'create' | 'update' | 'unchanged' | 'remove' | 'conflict';

export type Change =
  | { type: 'none' }
  | { type: 'write'; content: string }
  | { type: 'delete' }
  | { type: 'symlink'; target: string }
  | { type: 'copy-tree'; source: string; setup?: string; backup?: string }
  | { type: 'link-tree'; target: string; backup?: string }
  | { type: 'delete-tree' };

export interface PlannedAction {
  path: string;
  writePath?: string;
  label: string;
  skill?: string;
  status: ActionStatus;
  change: Change;
  entry: ManifestEntry | null;
  previous: ManifestEntry | null;
  reason?: string;
}

export interface TargetLabel {
  path: string;
  label: string;
}

export const NONE: Change = { type: 'none' };
export const REMOVAL_LABEL = 'no longer selected';
export const CHANGED_OUTSIDE = 'changed outside skills-wizard, left in place';
export const NOTHING_LEFT = 'nothing left to remove';
export const NOT_MANAGED = 'exists and is not managed by skills-wizard';
export const SOURCE_UNAVAILABLE = 'source unavailable, left as it is';

const LOCATION_PROBLEMS = {
  outside: 'resolves outside the project',
  dangling: 'links to a missing location',
} as const;

export type LocationProblem = keyof typeof LOCATION_PROBLEMS;

interface LocationCheckParams {
  path: string;
  boundary?: string;
}

export async function locationProblem({
  path,
  boundary,
}: LocationCheckParams): Promise<LocationProblem | undefined> {
  const real = await realLocation(path);

  if (real === null) return 'dangling';

  if (boundary !== undefined && !isInside({ dir: boundary, path: real })) {
    return 'outside';
  }

  return undefined;
}

export function leftInPlace(problem: LocationProblem): string {
  return `${LOCATION_PROBLEMS[problem]}, left in place`;
}

interface ConflictParams {
  target: TargetLabel;
  previous: ManifestEntry | null;
  reason: string;
}

export function conflict({
  target,
  previous,
  reason,
}: ConflictParams): PlannedAction {
  return {
    path: target.path,
    label: target.label,
    status: 'conflict',
    change: NONE,
    entry: previous,
    previous,
    reason,
  };
}

interface GuardedParams {
  target: TargetLabel;
  previous: ManifestEntry | null;
  plan: () => Promise<PlannedAction>;
}

export async function guarded({
  target,
  previous,
  plan,
}: GuardedParams): Promise<PlannedAction> {
  try {
    return await plan();
  } catch (error) {
    const reason = fsErrorReason(error);
    if (reason === undefined) throw error;

    return conflict({ target, previous, reason });
  }
}

interface ManifestLocationCheckParams {
  manifestPath: string;
  boundary?: string;
}

export async function checkManifestPath({
  manifestPath,
  boundary,
}: ManifestLocationCheckParams): Promise<void> {
  if ((await lstatIfExists(manifestPath))?.isSymbolicLink()) {
    throw new ManifestError(
      `${manifestPath} is a symlink; replace it with a regular file`,
    );
  }

  const problem = await locationProblem({
    path: manifestPath,
    boundary,
  });

  if (problem) {
    throw new ManifestError(
      `${manifestPath} ${LOCATION_PROBLEMS[problem]}; refusing to record the install there`,
    );
  }
}

export type FileInspection =
  | {
      ok: true;
      writePath: string;
      viaLink: boolean;
      current: string | null;
      onDisk: string | null;
    }
  | { ok: false; action: PlannedAction };

export interface InspectTargetFileParams {
  target: TargetLabel & { kind: ManifestEntry['kind'] };
  previous: ManifestEntry | null;
  staged: StagedContents;
  boundary?: string;
  danglingTargetReason?: string;
}

export async function inspectTargetFile({
  target,
  previous,
  staged,
  boundary,
  danglingTargetReason,
}: InspectTargetFileParams): Promise<FileInspection> {
  const stats = await lstatIfExists(target.path);
  const resolved = stats?.isSymbolicLink()
    ? await resolveIfSymlink(target.path)
    : null;

  if (
    stats?.isSymbolicLink() &&
    resolved === null &&
    danglingTargetReason !== undefined
  ) {
    return {
      ok: false,
      action: conflict({ target, previous, reason: danglingTargetReason }),
    };
  }

  const writePath = resolved ?? target.path;
  const effectiveBoundary =
    target.kind === 'exclude-region' ? undefined : boundary;
  const problem = await locationProblem({
    path: writePath,
    boundary: effectiveBoundary,
  });

  if (problem) {
    return {
      ok: false,
      action: conflict({ target, previous, reason: leftInPlace(problem) }),
    };
  }

  const kindProblem = fileKindProblem(await statIfExists(writePath));

  if (kindProblem) {
    return {
      ok: false,
      action: conflict({ target, previous, reason: kindProblem }),
    };
  }

  const { current, onDisk } = await readStaged({ staged, path: writePath });

  return {
    ok: true,
    writePath,
    viaLink: resolved !== null,
    current,
    onDisk,
  };
}

export interface ResolvedTargetFile {
  writePath: string;
  existing: string | null;
  createdFile: boolean;
}

export interface FileActionParams<T extends FileTarget> {
  target: T;
  file: ResolvedTargetFile;
  previous: ManifestEntry | null;
}

interface WriteActionParams {
  target: TargetLabel;
  file: ResolvedTargetFile;
  next: string;
  entry: ManifestEntry;
  previous: ManifestEntry | null;
}

function writeStatus(existing: string | null, next: string): ActionStatus {
  if (existing === null) return 'create';
  return next === existing ? 'unchanged' : 'update';
}

export function writeAction({
  target,
  file,
  next,
  entry,
  previous,
}: WriteActionParams): PlannedAction {
  const status = writeStatus(file.existing, next);

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

export function wasCreated(
  existing: string | null,
  previous: ManifestEntry | null,
  pathCreated?: boolean,
): boolean {
  if (existing === null) return true;
  if (pathCreated) return true;

  return previous !== null && 'createdFile' in previous
    ? previous.createdFile
    : false;
}

export interface PlanFileParams {
  target: FileTarget;
  previous: ManifestEntry | null;
  staged: StagedContents;
  boundary?: string;
  pathCreated?: boolean;
}

export type ResolvedTargetOutcome =
  { ok: true; file: ResolvedTargetFile } | { ok: false; action: PlannedAction };

export async function resolveTargetFile({
  target,
  previous,
  staged,
  boundary,
  pathCreated,
}: PlanFileParams): Promise<ResolvedTargetOutcome> {
  const inspection = await inspectTargetFile({
    target,
    previous,
    staged,
    boundary,
    danglingTargetReason: 'is a symlink to a missing file',
  });

  if (!inspection.ok) return inspection;

  return {
    ok: true,
    file: {
      writePath: inspection.writePath,
      existing: inspection.current,
      createdFile:
        !inspection.viaLink &&
        wasCreated(inspection.onDisk, previous, pathCreated),
    },
  };
}
