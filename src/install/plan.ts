import { requiredVariables, selectBlocks } from '../blocks/compose.ts';
import {
  type Manifest,
  MANIFEST_VERSION,
  type ManifestEntry,
  serializeManifest,
} from '../state/manifest.ts';
import { planTarget } from './file-actions.ts';
import { readTextIfExists } from './fs.ts';
import { planRemoval } from './removal.ts';
import {
  type ActionStatus,
  checkManifestPath,
  guarded,
  type PlannedAction,
  REMOVAL_LABEL,
} from './safety.ts';
import {
  keyOf,
  type PlanInput,
  type ProjectContext,
  type Selection,
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

interface PlanTargetActionsParams {
  targets: readonly Target[];
  previousEntries: ReadonlyMap<string, ManifestEntry>;
  boundary?: string;
}

async function planTargetActions({
  targets,
  previousEntries,
  boundary,
}: PlanTargetActionsParams): Promise<{
  actions: PlannedAction[];
  plannedKeys: Set<string>;
}> {
  const actions: PlannedAction[] = [];
  const plannedKeys = new Set<string>();
  for (const target of targets) {
    const key = keyOf(target);
    plannedKeys.add(key);
    const previous = previousEntries.get(key) ?? null;
    actions.push(
      await guarded({
        target,
        previous,
        plan: () =>
          planTarget({
            target,
            previous,
            ...(boundary ? { boundary } : {}),
          }),
      }),
    );
  }
  return { actions, plannedKeys };
}

interface PlanRemovalActionsParams {
  previousEntries: ReadonlyMap<string, ManifestEntry>;
  plannedKeys: ReadonlySet<string>;
  boundary?: string;
}

async function planRemovalActions({
  previousEntries,
  plannedKeys,
  boundary,
}: PlanRemovalActionsParams): Promise<PlannedAction[]> {
  const actions: PlannedAction[] = [];
  for (const [key, entry] of previousEntries) {
    if (plannedKeys.has(key)) continue;
    actions.push(
      await guarded({
        target: { path: entry.path, label: REMOVAL_LABEL },
        previous: entry,
        plan: () =>
          planRemoval({
            entry,
            ...(boundary ? { boundary } : {}),
          }),
      }),
    );
  }
  return actions;
}

function composeManifestMetadata({
  scope,
  selection,
  library,
}: PlanInput): Omit<Manifest, 'entries'> {
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
    variables,
    options:
      scope === 'global'
        ? { linkCommand: selection.linkCommand }
        : { keepLocal: selection.keepLocal },
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

export async function buildPlan(input: PlanInput): Promise<Plan> {
  const { scope, previous, manifestPath, project } = input;
  const boundary = scope === 'project' ? project?.dir : undefined;
  await checkManifestPath({
    manifestPath,
    ...(boundary ? { boundary } : {}),
  });

  const previousEntries = new Map(
    (previous?.entries ?? []).map((entry) => [keyOf(entry), entry]),
  );
  const { actions: targetActions, plannedKeys } = await planTargetActions({
    targets: targetsForPlan(input),
    previousEntries,
    ...(boundary ? { boundary } : {}),
  });
  const removalActions = await planRemovalActions({
    previousEntries,
    plannedKeys,
    ...(boundary ? { boundary } : {}),
  });
  const actions = [...targetActions, ...removalActions];

  const manifest = composeManifestMetadata(input);
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
