import { dirname, resolve } from 'node:path';

import type { Scope } from '../blocks/library.ts';
import type { SkillSource } from '../skills/install.ts';
import { hashInstalledCopy, hashTree } from '../skills/tree.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { lstatIfExists, readSymlink, realLocation } from './fs.ts';
import {
  type Change,
  CHANGED_OUTSIDE,
  conflict,
  leftInPlace,
  locationProblem,
  NONE,
  NOT_MANAGED,
  type PlannedAction,
  SOURCE_UNAVAILABLE,
} from './safety.ts';
import type { SkillTarget, SymlinkTarget } from './targets.ts';

export type SkillEntry = Extract<ManifestEntry, { kind: 'skill' }>;

export const SHARED_FOLDER = 'tool reads the shared skills folder';

export type InstalledState = 'missing' | 'owned' | 'changed' | 'unmanaged';

interface InstalledStateOptions {
  sourceHasSetup?: boolean;
}

export async function installedState(
  path: string,
  prior: SkillEntry | null,
  { sourceHasSetup }: InstalledStateOptions = {},
): Promise<InstalledState> {
  const stats = await lstatIfExists(path);
  if (!stats) return 'missing';
  if (!prior) return 'unmanaged';
  if (prior.install.mode === 'link') {
    return (await readSymlink(path)) === prior.install.target
      ? 'owned'
      : 'changed';
  }
  if (!stats.isDirectory()) return 'changed';
  // Copies always record `setup`; records written before the flag existed
  // have none, so the current source decides whether setup output is
  // expected. Without a source (removal), setup output is not assumed, so a
  // legacy copy is never deleted together with files a user added.
  const setup = prior.install.setup ?? sourceHasSetup ?? false;
  const hash = await hashInstalledCopy({ dir: path, setup });
  return hash === prior.install.hash ? 'owned' : 'changed';
}

interface InstallPairParams {
  current: SkillEntry['install'];
  next: SkillEntry['install'];
}

function sameInstall({ current, next }: InstallPairParams): boolean {
  return current.mode === 'copy'
    ? next.mode === 'copy' &&
        next.hash === current.hash &&
        (next.setup ?? false) === (current.setup ?? false)
    : next.mode === 'link' && next.target === current.target;
}

interface PlaceSkillParams {
  source: SkillSource;
  install: SkillEntry['install'];
  backup?: string;
}

function placeSkill({ source, install, backup }: PlaceSkillParams): Change {
  const kept = backup === undefined ? {} : { backup };
  if (install.mode === 'link') {
    return { type: 'link-tree', target: install.target, ...kept };
  }
  return {
    type: 'copy-tree',
    source: source.dir,
    ...(source.setup ? { setup: source.setup } : {}),
    ...kept,
  };
}

async function folderLocation(dir: string): Promise<string | null> {
  const real = await realLocation(dir);
  if (real !== null) return real;
  const target = await readSymlink(dir);
  return target === null ? null : realLocation(resolve(dirname(dir), target));
}

interface SharedFolderParams {
  path: string;
  target: string;
}

export async function sharesSkillsFolder({
  path,
  target,
}: SharedFolderParams): Promise<boolean> {
  const [linkFolder, copyFolder] = await Promise.all([
    folderLocation(dirname(path)),
    folderLocation(dirname(resolve(dirname(path), target))),
  ]);
  return linkFolder !== null && linkFolder === copyFolder;
}

export interface PlanSymlinkParams {
  target: SymlinkTarget;
  previous: ManifestEntry | null;
  boundary?: string;
}

export async function planSymlink({
  target,
  previous,
  boundary,
}: PlanSymlinkParams): Promise<PlannedAction> {
  if (target.skill !== undefined && (await sharesSkillsFolder(target))) {
    return {
      path: target.path,
      label: target.label,
      status: 'unchanged',
      change: NONE,
      entry: null,
      previous,
      reason: SHARED_FOLDER,
    };
  }
  const problem = await locationProblem({
    path: dirname(target.path),
    ...(boundary ? { boundary } : {}),
  });
  if (problem) {
    return conflict({ target, previous, reason: leftInPlace(problem) });
  }
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
  if (!previous && target.backup !== undefined) {
    return {
      ...base,
      label: `${target.label}, backing up what is there`,
      status: 'update',
      change: {
        type: 'link-tree',
        target: target.target,
        backup: target.backup,
      },
    };
  }
  return conflict({
    target,
    previous,
    reason: previous ? CHANGED_OUTSIDE : NOT_MANAGED,
  });
}

export interface PlanSkillParams {
  target: SkillTarget;
  previous: ManifestEntry | null;
  scope: Scope;
  boundary?: string;
}

export async function planSkill({
  target,
  previous,
  scope,
  boundary,
}: PlanSkillParams): Promise<PlannedAction> {
  const problem = await locationProblem({
    path: dirname(target.path),
    ...(boundary ? { boundary } : {}),
  });
  if (problem) {
    return conflict({ target, previous, reason: leftInPlace(problem) });
  }
  const { source } = target;
  if (!source) {
    return {
      path: target.path,
      label: target.label,
      status: 'unchanged',
      change: NONE,
      entry: previous,
      previous,
      reason: SOURCE_UNAVAILABLE,
    };
  }

  const prior = previous?.kind === 'skill' ? previous : null;
  const install: SkillEntry['install'] =
    target.mode === 'link'
      ? { mode: 'link', target: source.dir }
      : {
          mode: 'copy',
          hash: await hashTree(source.dir),
          setup: source.setup !== undefined,
        };
  const entry: ManifestEntry = {
    kind: 'skill',
    path: target.path,
    name: target.name,
    source: source.record,
    install,
  };
  const label =
    install.mode === 'copy' && source.setup
      ? `${target.label}, then runs "${source.setup}"`
      : target.label;
  const base = { path: target.path, label, entry, previous };

  const state = await installedState(target.path, prior, {
    sourceHasSetup: source.setup !== undefined,
  });
  if (state === 'missing') {
    return {
      ...base,
      status: 'create',
      change: placeSkill({ source, install }),
    };
  }
  if (state === 'unmanaged') {
    if (target.backup !== undefined) {
      return {
        ...base,
        label: `${label}, backing up what is there`,
        status: 'update',
        change: placeSkill({ source, install, backup: target.backup }),
      };
    }
    return conflict({
      target,
      previous,
      reason:
        scope === 'global'
          ? `${NOT_MANAGED}; run agents-config adopt ${target.name} to take it over`
          : NOT_MANAGED,
    });
  }
  if (state === 'changed' || !prior) {
    return conflict({ target, previous, reason: CHANGED_OUTSIDE });
  }
  if (sameInstall({ current: prior.install, next: install })) {
    return { ...base, label: target.label, status: 'unchanged', change: NONE };
  }
  return {
    ...base,
    status: 'update',
    change: placeSkill({ source, install }),
  };
}
