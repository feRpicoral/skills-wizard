import { dirname } from 'node:path';

import type { Scope } from '../blocks/library.ts';
import type { SkillSource } from '../skills/install.ts';
import { hashTree } from '../skills/tree.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import { lstatIfExists, readSymlink } from './fs.ts';
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

export type InstalledState = 'missing' | 'owned' | 'changed' | 'unmanaged';

export async function installedState(
  path: string,
  prior: SkillEntry | null,
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
  return (await hashTree(path)) === prior.install.hash ? 'owned' : 'changed';
}

interface InstallPairParams {
  current: SkillEntry['install'];
  next: SkillEntry['install'];
}

function sameInstall({ current, next }: InstallPairParams): boolean {
  return current.mode === 'copy'
    ? next.mode === 'copy' && next.hash === current.hash
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
      : { mode: 'copy', hash: await hashTree(source.dir) };
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

  const state = await installedState(target.path, prior);
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
