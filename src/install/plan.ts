import type { Scope } from '../blocks/library.ts';
import {
  checkMcpEntries,
  checkSkillEntries,
  type Manifest,
  type ManifestEntry,
} from '../state/manifest.ts';
import {
  canonicalPath,
  collectConflictedMcpByReal,
  filterClaudeDeniedValues,
  initCoownedJsonState,
  ownersByRealLocation,
  ownershipKey,
  recordPlannedCoownedEntry,
  retainedMcpServersForRemoval,
} from './coowned-state.ts';
import {
  type EmptyJsonState,
  planFile,
  type SharedMcpJsonState,
} from './file-actions.ts';
import {
  composeManifestMetadata,
  type ManifestStatus,
  resolveManifestEntries,
  resolveManifestStatus,
} from './manifest-plan.ts';
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
  mcpConfigPaths,
  type PlanInput,
  type ProjectContext,
  type Selection,
  skillFolders,
  type Target,
  targetsForPlan,
} from './targets.ts';

export type {
  ActionStatus,
  ManifestStatus,
  PlannedAction,
  ProjectContext,
  Selection,
};
export { resolveManifestEntries };

export interface Plan {
  actions: PlannedAction[];
  manifest: Omit<Manifest, 'entries'>;
  manifestPath: string;
  manifestStatus: ManifestStatus;
  projectDir?: string;
  warnings?: string[];
}

interface DispatchTargetParams {
  target: Target;
  previous: ManifestEntry | null;
  scope: Scope;
  staged: StagedContents;
  boundary?: string;
  pathCreated?: boolean;
  emptyJson?: EmptyJsonState;
  sharedMcp?: SharedMcpJsonState;
}

function dispatchTarget({
  target,
  previous,
  scope,
  staged,
  boundary,
  pathCreated,
  emptyJson,
  sharedMcp,
}: DispatchTargetParams): Promise<PlannedAction> {
  switch (target.kind) {
    case 'symlink':
      return planSymlink({ target, previous, boundary });
    case 'skill':
      return planSkill({ target, previous, scope, boundary });
    default:
      return planFile({
        target,
        previous,
        staged,
        boundary,
        pathCreated,
        emptyJson,
        sharedMcp,
      });
  }
}

interface PlanTargetActionsParams {
  targets: readonly Target[];
  previousEntries: ReadonlyMap<string, ManifestEntry>;
  scope: Scope;
  staged: StagedContents;
  boundary?: string;
}

function unionValues(
  first: readonly string[],
  second: readonly string[],
): string[] {
  return [...new Set([...first, ...second])];
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
  const coowned = await initCoownedJsonState({ previousEntries, targets });

  let claudeMcpServers: ReadonlySet<string> | null = null;
  let claudeMcpConflicted = false;

  for (const rawTarget of targets) {
    let target = rawTarget;
    const key = keyOf(target);
    const previous = previousEntries.get(key) ?? null;

    if (
      target.kind === 'json-array' &&
      target.mcpPermissionClient === 'claude-code' &&
      claudeMcpServers !== null
    ) {
      const candidateValues =
        claudeMcpConflicted && previous?.kind === 'json-array'
          ? unionValues(previous.added, target.values)
          : target.values;
      const values = filterClaudeDeniedValues({
        values: candidateValues,
        allowedServers: claudeMcpServers,
      });

      if (claudeMcpConflicted) {
        plannedKeys.add(key);
      }

      if (values.length === 0) {
        continue;
      }

      target = { ...target, values };
    }

    plannedKeys.add(key);

    if (
      target.kind === 'symlink' &&
      target.skill !== undefined &&
      blockedSkills.has(target.skill)
    ) {
      actions.push(
        conflict({
          target,
          previous,
          reason: `waits for the ${target.skill} skill folder`,
        }),
      );
      continue;
    }

    const real = await canonicalPath(target.path);
    const emptyJson = coowned.emptyJsonByPath.get(real);
    const sharedMcp =
      target.kind === 'mcp-json' ? coowned.mcpByRealPath.get(real) : undefined;
    const action = await guarded({
      target,
      previous,
      plan: () =>
        dispatchTarget({
          target,
          previous,
          scope,
          staged,
          boundary,
          pathCreated:
            coowned.createdPaths.has(target.path) ||
            coowned.createdPaths.has(real),
          emptyJson,
          sharedMcp,
        }),
    });

    if (target.kind === 'skill' && action.status === 'conflict') {
      blockedSkills.add(target.name);
    }

    if (
      target.kind === 'mcp-json' &&
      (target.mcpClient === 'claude-code' ||
        target.mcpClient === 'claude-copilot-shared')
    ) {
      if (action.status !== 'conflict' && action.entry?.kind === 'mcp-json') {
        claudeMcpServers = new Set(action.entry.servers);
        claudeMcpConflicted = false;
      } else {
        claudeMcpServers = new Set(
          action.previous?.kind === 'mcp-json' ? action.previous.servers : [],
        );
        claudeMcpConflicted = true;
      }
    }

    await recordPlannedCoownedEntry(coowned, action);
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
  targetActions: readonly PlannedAction[];
  owners: ReadonlyMap<string, string>;
  staged: StagedContents;
  boundary?: string;
}

async function planRemovalActions({
  previousEntries,
  plannedKeys,
  targetActions,
  owners,
  staged,
  boundary,
}: PlanRemovalActionsParams): Promise<PlannedAction[]> {
  const actions: PlannedAction[] = [];
  const pending = [...previousEntries.entries()]
    .filter(([key]) => !plannedKeys.has(key))
    .map(([, entry]) => entry);
  const ordered = [
    ...pending.filter(
      (entry) => !('createdFile' in entry && entry.createdFile),
    ),
    ...pending.filter((entry) => 'createdFile' in entry && entry.createdFile),
  ];

  const conflictedMcpByReal = await collectConflictedMcpByReal(targetActions);

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!;
    const action = await guarded({
      target: { path: entry.path, label: REMOVAL_LABEL },
      previous: entry,
      plan: async () => {
        const owner = await ownershipKey(entry);
        const sharedWith = owner === null ? undefined : owners.get(owner);
        const retainedMcpServers = await retainedMcpServersForRemoval({
          entry,
          laterEntries: ordered.slice(index + 1),
          conflictedMcpByReal,
        });

        return planRemoval({
          entry,
          staged,
          sharedWith,
          boundary,
          retainedMcpServers,
        });
      },
    });

    await stageAction({ staged, action });
    actions.push(action);
  }

  return actions;
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
export async function buildPlan(input: PlanInput): Promise<Plan> {
  const { scope, selection, library, paths, previous, manifestPath, project } =
    input;
  const boundary = scope === 'project' ? project?.dir : undefined;

  await checkManifestPath({
    manifestPath,
    boundary,
  });

  const folders = skillFolders({ scope, paths, project });

  if (previous && folders) {
    checkSkillEntries({
      file: manifestPath,
      entries: previous.entries,
      folders,
      scope,
    });
  }

  const mcpPaths = mcpConfigPaths(input);

  if (previous && mcpPaths) {
    checkMcpEntries({
      file: manifestPath,
      entries: previous.entries,
      mcpPaths,
    });
  }

  const { targets, warnings } = targetsForPlan(input);
  const previousEntries = new Map(
    (previous?.entries ?? []).map((entry) => [keyOf(entry), entry]),
  );
  const staged: StagedContents = new Map();
  const { actions: targetActions, plannedKeys } = await planTargetActions({
    targets,
    previousEntries,
    scope,
    staged,
    boundary,
  });
  const removalActions = await planRemovalActions({
    previousEntries,
    plannedKeys,
    targetActions,
    owners: await ownersByRealLocation(targetActions),
    staged,
    boundary,
  });
  const actions = [...targetActions, ...removalActions];

  const manifest = composeManifestMetadata({ scope, selection, library });
  const effective = resolveManifestEntries({
    manifest,
    actions,
    isApplied: (action) => action.status !== 'conflict',
  });
  const manifestStatus = await resolveManifestStatus({
    manifest: effective.manifest,
    entries: effective.entries,
    manifestPath,
    projectDir: project?.dir,
  });

  return {
    actions,
    manifest: effective.manifest,
    manifestPath,
    manifestStatus,
    ...(project ? { projectDir: project.dir } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
