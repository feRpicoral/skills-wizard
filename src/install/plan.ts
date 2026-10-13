import { parsePath } from 'dot-prop';

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
import {
  type EmptyJsonState,
  planFile,
  type SharedMcpJsonState,
} from './file-actions.ts';
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
        ...(sharedMcp ? { sharedMcp } : {}),
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

async function canonicalPath(path: string): Promise<string> {
  return (await realLocation(path)) ?? path;
}

function rootOriginalForEntry(entry: ManifestEntry): string | undefined {
  if (entry.kind === 'json-array') {
    return entry.original !== undefined &&
      entry.createdKeys !== undefined &&
      entry.createdKeys === parsePath(entry.key).length
      ? entry.original
      : undefined;
  }
  if (entry.kind === 'mcp-json') {
    return entry.original !== undefined && entry.createdMcpServers
      ? entry.original
      : undefined;
  }
  return undefined;
}

function emptyJsonStateForEntry(
  entry: ManifestEntry,
): EmptyJsonState | undefined {
  if (entry.kind !== 'json-array' && entry.kind !== 'mcp-json') {
    return undefined;
  }
  const rootOriginal = rootOriginalForEntry(entry);
  if (!entry.wasEmpty && rootOriginal === undefined) {
    return undefined;
  }
  return {
    ...(entry.wasEmpty ? { wasEmpty: true } : {}),
    ...(entry.blankText !== undefined ? { blankText: entry.blankText } : {}),
    ...(rootOriginal !== undefined ? { rootOriginal } : {}),
  };
}

interface MergeEmptyJsonStateParams {
  current: EmptyJsonState | undefined;
  next: EmptyJsonState;
}

function mergeEmptyJsonState({
  current,
  next,
}: MergeEmptyJsonStateParams): EmptyJsonState {
  const wasEmpty = current?.wasEmpty ?? next.wasEmpty;
  const blankText = current?.blankText ?? next.blankText;
  const rootOriginal = current?.rootOriginal ?? next.rootOriginal;
  return {
    ...(wasEmpty ? { wasEmpty: true } : {}),
    ...(blankText !== undefined ? { blankText } : {}),
    ...(rootOriginal !== undefined ? { rootOriginal } : {}),
  };
}

interface FilterClaudeDeniedValuesParams {
  values: readonly string[];
  allowedServers: ReadonlySet<string>;
}

function filterClaudeDeniedValues({
  values,
  allowedServers,
}: FilterClaudeDeniedValuesParams): string[] {
  return values.filter((rule) => {
    const match = /^mcp__([^_]+)__/.exec(rule);
    return match?.[1] !== undefined && allowedServers.has(match[1]);
  });
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
  const createdPaths = new Set<string>();
  const emptyJsonByPath = new Map<string, EmptyJsonState>();
  const mcpByRealPath = new Map<string, SharedMcpJsonState>();

  for (const entry of previousEntries.values()) {
    const real = await canonicalPath(entry.path);
    if ('createdFile' in entry && entry.createdFile) {
      createdPaths.add(entry.path);
      createdPaths.add(real);
    }
    const emptyState = emptyJsonStateForEntry(entry);
    if (emptyState) {
      emptyJsonByPath.set(
        real,
        mergeEmptyJsonState({
          current: emptyJsonByPath.get(real),
          next: emptyState,
        }),
      );
    }
    if (entry.kind === 'mcp-json') {
      const mcpState = mcpByRealPath.get(real) ?? {
        previousOwned: new Set<string>(),
        plannedServers: new Set<string>(),
        stagedServers: new Set<string>(),
      };
      for (const name of entry.servers) {
        mcpState.previousOwned.add(name);
      }
      if (entry.createdMcpServers) {
        mcpState.createdMcpServers = true;
      }
      if (entry.original !== undefined && mcpState.original === undefined) {
        mcpState.original = entry.original;
      }
      mcpByRealPath.set(real, mcpState);
    }
  }

  for (const target of targets) {
    if (target.kind !== 'mcp-json') continue;
    const real = await canonicalPath(target.path);
    const mcpState = mcpByRealPath.get(real) ?? {
      previousOwned: new Set<string>(),
      plannedServers: new Set<string>(),
      stagedServers: new Set<string>(),
    };
    for (const name of Object.keys(target.servers)) {
      mcpState.plannedServers.add(name);
    }
    mcpByRealPath.set(real, mcpState);
  }

  let claudeMcpServers: ReadonlySet<string> | null = null;
  for (const rawTarget of targets) {
    let target = rawTarget;
    const key = keyOf(target);
    const previous = previousEntries.get(key) ?? null;

    if (
      target.kind === 'json-array' &&
      target.label === 'Claude Code MCP tool permissions' &&
      claudeMcpServers !== null
    ) {
      const values = filterClaudeDeniedValues({
        values: target.values,
        allowedServers: claudeMcpServers,
      });
      if (values.length === 0) {
        continue;
      }
      target = { ...target, values };
    }

    plannedKeys.add(key);
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
    const real = await canonicalPath(target.path);
    const emptyJson = emptyJsonByPath.get(real);
    const sharedMcp =
      target.kind === 'mcp-json' ? mcpByRealPath.get(real) : undefined;
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
          pathCreated: createdPaths.has(target.path) || createdPaths.has(real),
          ...(emptyJson ? { emptyJson } : {}),
          ...(sharedMcp ? { sharedMcp } : {}),
        }),
    });
    if (target.kind === 'skill' && action.status === 'conflict') {
      blockedSkills.add(target.name);
    }
    if (target.kind === 'mcp-json' && target.label.includes('Claude Code')) {
      if (action.status !== 'conflict' && action.entry?.kind === 'mcp-json') {
        claudeMcpServers = new Set(action.entry.servers);
      } else {
        claudeMcpServers = new Set(
          action.previous?.kind === 'mcp-json' ? action.previous.servers : [],
        );
      }
    }
    if (action.entry) {
      const entryReal = await canonicalPath(
        action.writePath ?? action.entry.path,
      );
      if ('createdFile' in action.entry && action.entry.createdFile) {
        createdPaths.add(action.entry.path);
        createdPaths.add(entryReal);
      }
      const emptyState = emptyJsonStateForEntry(action.entry);
      if (emptyState) {
        emptyJsonByPath.set(
          entryReal,
          mergeEmptyJsonState({
            current: emptyJsonByPath.get(entryReal),
            next: emptyState,
          }),
        );
      }
    }
    await stageAction({ staged, action });
    actions.push(action);
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

  const conflictedMcpByReal = new Map<string, Set<string>>();
  for (const action of targetActions) {
    if (action.status === 'conflict' && action.previous?.kind === 'mcp-json') {
      const real = await canonicalPath(action.previous.path);
      const set = conflictedMcpByReal.get(real) ?? new Set<string>();
      for (const name of action.previous.servers) {
        set.add(name);
      }
      conflictedMcpByReal.set(real, set);
    }
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!;
    const action = await guarded({
      target: { path: entry.path, label: REMOVAL_LABEL },
      previous: entry,
      plan: async () => {
        const owner = await ownershipKey(entry);
        const sharedWith = owner === null ? undefined : owners.get(owner);
        let retainedMcpServers: Set<string> | undefined;
        if (entry.kind === 'mcp-json') {
          const real = await canonicalPath(entry.path);
          retainedMcpServers = new Set(conflictedMcpByReal.get(real) ?? []);
          for (const later of ordered.slice(index + 1)) {
            if (later.kind !== 'mcp-json') continue;
            if ((await canonicalPath(later.path)) === real) {
              for (const name of later.servers) {
                retainedMcpServers.add(name);
              }
            }
          }
        }
        return planRemoval({
          entry,
          staged,
          ...(sharedWith ? { sharedWith } : {}),
          ...(boundary ? { boundary } : {}),
          ...(retainedMcpServers !== undefined ? { retainedMcpServers } : {}),
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
  const recordedMcp = new Set(
    entries.flatMap((entry) =>
      entry.kind === 'mcp-json' || entry.kind === 'mcp-toml'
        ? entry.servers
        : [],
    ),
  );
  const mcp = [
    ...manifest.mcp.filter((name) => recordedMcp.has(name)),
    ...[...recordedMcp].filter((name) => !manifest.mcp.includes(name)),
  ];
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
    targetActions,
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
    manifest: effective.manifest,
    manifestPath,
    manifestStatus,
    ...(project ? { projectDir: project.dir } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
