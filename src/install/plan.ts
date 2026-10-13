import { requiredVariables, selectBlocks } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
import {
  checkMcpEntries,
  checkSkillEntries,
  type Manifest,
  MANIFEST_VERSION,
  type ManifestEntry,
  serializeManifest,
} from '../state/manifest.ts';
import { type EmptyJsonState, planFile } from './file-actions.ts';
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
  mcpConfigPaths,
  mcpWarningsForPlan,
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
}

function dispatchTarget({
  target,
  previous,
  scope,
  staged,
  boundary,
  pathCreated,
  emptyJson,
}: DispatchTargetParams): Promise<PlannedAction> {
  const location = boundary ? { boundary } : {};
  switch (target.kind) {
    case 'symlink':
      return planSymlink({ target, previous, ...location });
    case 'skill':
      return planSkill({ target, previous, scope, ...location });
    default:
      return planFile({
        target,
        previous,
        staged,
        ...location,
        ...(pathCreated !== undefined ? { pathCreated } : {}),
        ...(emptyJson ? { emptyJson } : {}),
      });
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
  const createdPaths = new Set(
    [...previousEntries.values()].flatMap((entry) =>
      'createdFile' in entry && entry.createdFile ? [entry.path] : [],
    ),
  );
  const emptyJsonByPath = new Map<string, EmptyJsonState>();
  for (const entry of previousEntries.values()) {
    if (
      (entry.kind === 'json-array' || entry.kind === 'mcp-json') &&
      entry.wasEmpty
    ) {
      emptyJsonByPath.set(entry.path, {
        wasEmpty: true,
        ...(entry.blankText !== undefined
          ? { blankText: entry.blankText }
          : {}),
      });
    }
  }
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
    const emptyJson = emptyJsonByPath.get(target.path);
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
          pathCreated: createdPaths.has(target.path),
          ...(emptyJson ? { emptyJson } : {}),
        }),
    });
    if (target.kind === 'skill' && action.status === 'conflict') {
      blockedSkills.add(target.name);
    }
    if (
      action.entry &&
      (action.entry.kind === 'json-array' ||
        action.entry.kind === 'mcp-json') &&
      action.entry.wasEmpty
    ) {
      emptyJsonByPath.set(action.entry.path, {
        wasEmpty: true,
        ...(action.entry.blankText !== undefined
          ? { blankText: action.entry.blankText }
          : {}),
      });
    }
    await stageAction({ staged, action });
    actions.push(action);
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
    skills: [...selection.skills],
    mcp: [...(selection.mcp ?? [])],
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

export interface ResolveManifestEntriesParams {
  manifest: Omit<Manifest, 'entries'>;
  actions: readonly PlannedAction[];
  isApplied: (action: PlannedAction) => boolean;
}

function isMcpAction(action: PlannedAction): boolean {
  return (
    action.entry?.kind === 'mcp-json' ||
    action.entry?.kind === 'mcp-toml' ||
    action.previous?.kind === 'mcp-json' ||
    action.previous?.kind === 'mcp-toml' ||
    action.label.endsWith('MCP servers')
  );
}

export function resolveManifestEntries({
  manifest,
  actions,
  isApplied,
}: ResolveManifestEntriesParams): {
  manifest: Omit<Manifest, 'entries'>;
  entries: ManifestEntry[];
} {
  const entries = actions.flatMap((action) => {
    const entry = isApplied(action) ? action.entry : action.previous;
    return entry ? [entry] : [];
  });
  const recordedSkills = new Set(
    entries.flatMap((entry) => (entry.kind === 'skill' ? [entry.name] : [])),
  );
  const skills = [
    ...manifest.skills.filter((name) => recordedSkills.has(name)),
    ...[...recordedSkills].filter((name) => !manifest.skills.includes(name)),
  ];
  const skippedMcp = actions.some(
    (action) => !isApplied(action) && isMcpAction(action),
  );
  const recordedMcp = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'mcp-json' || entry.kind === 'mcp-toml'
        ? entry.servers
        : [],
    ),
  );
  const mcp = skippedMcp
    ? [
        ...manifest.mcp.filter((name) => recordedMcp.has(name)),
        ...[...recordedMcp].filter((name) => !manifest.mcp.includes(name)),
      ]
    : manifest.mcp;
  return {
    manifest: { ...manifest, skills, mcp },
    entries,
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

export async function buildPlan({
  scope,
  previous,
  manifestPath,
  project,
  ...rest
}: PlanInput): Promise<Plan> {
  const input: PlanInput = {
    scope,
    previous,
    manifestPath,
    ...(project ? { project } : {}),
    ...rest,
  };
  const boundary = scope === 'project' ? project?.dir : undefined;
  await checkManifestPath({
    manifestPath,
    ...(boundary ? { boundary } : {}),
  });
  const folders = skillFolders(input);
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

  const warnings = mcpWarningsForPlan(input);
  const previousEntries = new Map(
    (previous?.entries ?? []).map((entry) => [keyOf(entry), entry]),
  );
  const staged: StagedContents = new Map();
  const { actions: targetActions, plannedKeys } = await planTargetActions({
    targets: targetsForPlan(input),
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

  const manifest = composeManifestMetadata(input);
  const effective = resolveManifestEntries({
    manifest,
    actions,
    isApplied: (action) => action.status !== 'conflict',
  });
  const manifestStatus = await resolveManifestStatus({
    manifest: effective.manifest,
    entries: effective.entries,
    manifestPath,
    ...(project ? { projectDir: project.dir } : {}),
  });

  return {
    actions,
    manifest,
    manifestPath,
    manifestStatus,
    ...(project ? { projectDir: project.dir } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
