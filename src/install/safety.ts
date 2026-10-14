import type { Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { ManifestError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import {
  fsErrorReason,
  isInside,
  lstatIfExists,
  readSymlink,
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
  | { type: 'symlink'; target: string };

export interface PlannedAction {
  path: string;
  writePath?: string;
  label: string;
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
export const CHANGED_OUTSIDE = 'changed outside agents-config, left in place';
export const NOTHING_LEFT = 'nothing left to remove';

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

export function fileKindProblem(stats: Stats | null): string | undefined {
  if (!stats || stats.isFile()) return undefined;
  return stats.isDirectory() ? 'is a directory' : 'is not a regular file';
}

interface SymlinkMatchParams {
  link: string;
  destination: string;
}

async function linksTo({
  link,
  destination,
}: SymlinkMatchParams): Promise<boolean> {
  const target = await readSymlink(link);
  if (target === null) return false;
  const [linked, expected] = await Promise.all([
    realLocation(resolve(dirname(link), target)),
    realLocation(destination),
  ]);
  return linked !== null && linked === expected;
}

interface SameFileParams {
  path: string;
  other: string;
}

export async function sameFile({
  path,
  other,
}: SameFileParams): Promise<boolean> {
  if (
    (await linksTo({ link: path, destination: other })) ||
    (await linksTo({ link: other, destination: path }))
  ) {
    return true;
  }
  const [real, otherReal] = await Promise.all([
    realLocation(path),
    realLocation(other),
  ]);
  return real !== null && real === otherReal;
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
    ...(boundary ? { boundary } : {}),
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
    ...(effectiveBoundary ? { boundary: effectiveBoundary } : {}),
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

export function writeAction({
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

export function wasCreated(
  existing: string | null,
  previous: ManifestEntry | null,
): boolean {
  if (existing === null) return true;
  return previous !== null && 'createdFile' in previous
    ? previous.createdFile
    : false;
}

export interface PlanFileParams {
  target: FileTarget;
  previous: ManifestEntry | null;
  staged: StagedContents;
  boundary?: string;
}

export type ResolvedTargetOutcome =
  { ok: true; file: ResolvedTargetFile } | { ok: false; action: PlannedAction };

export async function resolveTargetFile({
  target,
  previous,
  staged,
  boundary,
}: PlanFileParams): Promise<ResolvedTargetOutcome> {
  const inspection = await inspectTargetFile({
    target,
    previous,
    staged,
    ...(boundary ? { boundary } : {}),
    danglingTargetReason: 'is a symlink to a missing file',
  });
  if (!inspection.ok) return inspection;
  return {
    ok: true,
    file: {
      writePath: inspection.writePath,
      existing: inspection.current,
      createdFile:
        !inspection.viaLink && wasCreated(inspection.onDisk, previous),
    },
  };
}
