import { requiredVariables, selectBlocks } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import {
  checkSkillEntries,
  type Manifest,
  MANIFEST_VERSION,
  type ManifestEntry,
  serializeManifest,
} from '../state/manifest.ts';
import { planFile } from './file-actions.ts';
import { readTextIfExists, realLocation } from './fs.ts';
import { planRemoval } from './removal.ts';
import {
  type ActionStatus,
  checkManifestPath,
  conflict,
  guarded,
  type PlannedAction,
  REMOVAL_LABEL,
} from './safety.ts';
import { planSkill, planSymlink } from './skill-actions.ts';
import { stageAction, type StagedContents } from './staged.ts';
import {
  keyOf,
  type PlanInput,
  type ProjectContext,
  type Selection,
  skillFolders,
  type Target,
  targetsForPlan,
} from './targets.ts';

export type { ActionStatus, PlannedAction, ProjectContext, Selection };

export type ManifestStatus = 'create' | 'update' | 'unchanged' | 'remove';

export interface Plan {
  actions: PlannedAction[];
  manifest: Omit<Manifest, 'entries'>;
  manifestPath: string;
  manifestStatus: ManifestStatus;
  projectDir?: string;
}

interface DispatchTargetParams {
  target: Target;
  previous: ManifestEntry | null;
  scope: Scope;
  staged: StagedContents;
  boundary?: string;
}

function dispatchTarget({
  target,
  previous,
  scope,
  staged,
  boundary,
}: DispatchTargetParams): Promise<PlannedAction> {
  const location = boundary ? { boundary } : {};
  switch (target.kind) {
    case 'symlink':
      return planSymlink({ target, previous, ...location });
    case 'skill':
      return planSkill({ target, previous, scope, ...location });
    default:
      return planFile({ target, previous, staged, ...location });
  }
}

function entryDetail(entry: ManifestEntry): string {
  switch (entry.kind) {
    case 'exclude-region':
      return entry.id;
    case 'line':
      return entry.line;
    case 'json-array':
      return entry.key;
    default:
      return '';
  }
}

async function ownershipKey(entry: ManifestEntry): Promise<string | null> {
  if (entry.kind === 'symlink') return null;
  const real = await realLocation(entry.path);
  return real === null ? null : `${entry.kind}:${real}:${entryDetail(entry)}`;
}

async function ownersByRealLocation(
  actions: readonly PlannedAction[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const action of actions) {
    if (!action.entry) continue;
    const key = await ownershipKey(action.entry);
    if (key !== null && !owners.has(key)) owners.set(key, action.label);
  }
  return owners;
}

interface PlanTargetActionsParams {
  targets: readonly Target[];
  previousEntries: ReadonlyMap<string, ManifestEntry>;
  scope: Scope;
  staged: StagedContents;
  boundary?: string;
}

async function planTargetActions({
  targets,
  previousEntries,
  scope,
  staged,
  boundary,
}: PlanTargetActionsParams): Promise<{
  actions: PlannedAction[];
  plannedKeys: Set<string>;
}> {
  const actions: PlannedAction[] = [];
  const plannedKeys = new Set<string>();
  const blockedSkills = new Set<string>();
  for (const target of targets) {
    const key = keyOf(target);
    plannedKeys.add(key);
    const previous = previousEntries.get(key) ?? null;
    if (target.kind === 'symlink' && target.skill !== undefined) {
      if (blockedSkills.has(target.skill)) {
        actions.push(
          conflict({
            target,
            previous,
            reason: `waits for the ${target.skill} skill folder`,
          }),
        );
        continue;
      }
    }
    const action = await guarded({
      target,
      previous,
      plan: () =>
        dispatchTarget({
          target,
          previous,
          scope,
          staged,
          ...(boundary ? { boundary } : {}),
        }),
    });
    if (target.kind === 'skill' && action.status === 'conflict') {
      blockedSkills.add(target.name);
    }
    await stageAction({ staged, action });
    actions.push(
      target.kind === 'skill' ? { ...action, skill: target.name } : action,
    );
  }
  return { actions, plannedKeys };
}

interface PlanRemovalActionsParams {
  previousEntries: ReadonlyMap<string, ManifestEntry>;
  plannedKeys: ReadonlySet<string>;
  owners: ReadonlyMap<string, string>;
  staged: StagedContents;
  boundary?: string;
}

async function planRemovalActions({
  previousEntries,
  plannedKeys,
  owners,
  staged,
  boundary,
}: PlanRemovalActionsParams): Promise<PlannedAction[]> {
  const actions: PlannedAction[] = [];
  for (const [key, entry] of previousEntries) {
    if (plannedKeys.has(key)) continue;
    const action = await guarded({
      target: { path: entry.path, label: REMOVAL_LABEL },
      previous: entry,
      plan: async () => {
        const owner = await ownershipKey(entry);
        const sharedWith = owner === null ? undefined : owners.get(owner);
        return planRemoval({
          entry,
          staged,
          ...(sharedWith ? { sharedWith } : {}),
          ...(boundary ? { boundary } : {}),
        });
      },
    });
    await stageAction({ staged, action });
    actions.push(action);
  }
  return actions;
}

type ComposeManifestMetadataParams = Pick<
  PlanInput,
  'scope' | 'selection' | 'library'
>;

function composeManifestMetadata({
  scope,
  selection,
  library,
}: ComposeManifestMetadataParams): Omit<Manifest, 'entries'> {
  const blocks = selectBlocks(library, selection.blocks, scope);
  const variables = Object.fromEntries(
    requiredVariables(blocks).flatMap((name) => {
      const value = selection.variables[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    version: MANIFEST_VERSION,
    scope,
    tools: [...selection.tools],
    blocks: blocks.map((block) => block.id),
    skills: [...selection.skills],
    variables,
    options:
      scope === 'global'
        ? {
            linkCommand: selection.linkCommand,
            skillMode: selection.skillMode,
          }
        : {
            keepLocal: selection.keepLocal,
            ...(selection.preset !== undefined
              ? { preset: selection.preset }
              : {}),
            ...(selection.style !== undefined
              ? { style: selection.style }
              : {}),
          },
  };
}

interface ResolveManifestStatusParams {
  manifest: Omit<Manifest, 'entries'>;
  entries: ManifestEntry[];
  manifestPath: string;
  projectDir?: string;
}

async function resolveManifestStatus({
  manifest,
  entries,
  manifestPath,
  projectDir,
}: ResolveManifestStatusParams): Promise<ManifestStatus> {
  const existing = await readTextIfExists(manifestPath);
  const content = serializeManifest({ ...manifest, entries }, projectDir);
  const empty = entries.length === 0 && manifest.tools.length === 0;
  if (empty) {
    return existing === null ? 'unchanged' : 'remove';
  }
  if (existing === null) return 'create';
  return existing === content ? 'unchanged' : 'update';
}

/**
 * Builds the non-destructive install and removal {@link Plan} for a global or
 * project configuration run without modifying the filesystem.
 *
 * Plans every selected target in order, stages each resulting write or delete
 * in memory by canonical `realLocation`, plans removals for entries present in
 * `previous` that are no longer selected (skipping files still owned by an
 * active target), and computes the next manifest metadata and status.
 *
 * @throws {ManifestError} If `manifestPath` is a symlink or resolves outside
 * the project boundary.
 */
export async function buildPlan({
  scope,
  selection,
  library,
  paths,
  previous,
  manifestPath,
  project,
  ...rest
}: PlanInput): Promise<Plan> {
  const boundary = scope === 'project' ? project?.dir : undefined;
  await checkManifestPath({
    manifestPath,
    ...(boundary ? { boundary } : {}),
  });
  const folders = skillFolders({
    scope,
    paths,
    ...(project ? { project } : {}),
  });
  if (previous && folders) {
    checkSkillEntries({
      file: manifestPath,
      entries: previous.entries,
      folders,
      scope,
    });
  }

  const previousEntries = new Map(
    (previous?.entries ?? []).map((entry) => [keyOf(entry), entry]),
  );
  const staged: StagedContents = new Map();
  const { actions: targetActions, plannedKeys } = await planTargetActions({
    targets: targetsForPlan({
      scope,
      selection,
      library,
      paths,
      previous,
      manifestPath,
      ...(project ? { project } : {}),
      ...rest,
    }),
    previousEntries,
    scope,
    staged,
    ...(boundary ? { boundary } : {}),
  });
  const removalActions = await planRemovalActions({
    previousEntries,
    plannedKeys,
    owners: await ownersByRealLocation(targetActions),
    staged,
    ...(boundary ? { boundary } : {}),
  });
  const actions = [...targetActions, ...removalActions];

  const manifest = composeManifestMetadata({ scope, selection, library });
  const entries = actions.flatMap((action) =>
    action.entry ? [action.entry] : [],
  );
  const manifestStatus = await resolveManifestStatus({
    manifest,
    entries,
    manifestPath,
    ...(project ? { projectDir: project.dir } : {}),
  });

  return {
    actions,
    manifest,
    manifestPath,
    manifestStatus,
    ...(project ? { projectDir: project.dir } : {}),
  };
}
