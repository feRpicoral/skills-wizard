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
} from './fs.ts';

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
