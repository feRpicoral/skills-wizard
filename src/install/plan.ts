import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  composeGlobal,
  composeProject,
  requiredVariables,
  selectBlocks,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import {
  JsonMergeError,
  ManagedRegionError,
  ManifestError,
} from '../errors.ts';
import {
  type Manifest,
  MANIFEST_VERSION,
  type ManifestEntry,
  serializeManifest,
} from '../state/manifest.ts';
import { orderedTools, type ToolId } from '../tools/registry.ts';
import {
  fsErrorReason,
  isInside,
  lstatIfExists,
  readSymlink,
  readTextIfExists,
  realLocation,
  resolveIfSymlink,
  statIfExists,
} from './fs.ts';
import { ensureLine, hasLine, removeLine } from './import-line.ts';
import {
  ensureArrayValues,
  parseJsonObject,
  removeArrayValues,
  serializeJson,
} from './json-merge.ts';
import {
  excludeMarkers,
  MARKDOWN_MARKERS,
  removeRegion,
  upsertRegion,
} from './managed-region.ts';

export type ActionStatus =
  'create' | 'update' | 'unchanged' | 'remove' | 'conflict';

type Change =
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

export interface Selection {
  tools: ToolId[];
  blocks: string[];
  variables: Record<string, string>;
  linkCommand: boolean;
  keepLocal: boolean;
}

export interface ProjectContext {
  dir: string;
  title: string;
  git?: { root: string; excludePath: string };
}

interface PlanInput {
  scope: Scope;
  selection: Selection;
  library: BlockLibrary;
  paths: Paths;
  repoRoot: string;
  previous: Manifest | null;
  manifestPath: string;
  project?: ProjectContext;
}

export type ManifestStatus = 'create' | 'update' | 'unchanged' | 'remove';

export interface Plan {
  actions: PlannedAction[];
  manifest: Omit<Manifest, 'entries'>;
  manifestPath: string;
  manifestStatus: ManifestStatus;
  projectDir?: string;
}

type Target =
  | {
      kind: 'region';
      path: string;
      body: string;
      preamble?: string;
      label: string;
    }
  | {
      kind: 'exclude-region';
      path: string;
      id: string;
      body: string;
      label: string;
    }
  | {
      kind: 'line';
      path: string;
      line: string;
      satisfiedBy?: string;
      label: string;
    }
  | {
      kind: 'json-array';
      path: string;
      key: string;
      values: readonly string[];
      label: string;
    }
  | { kind: 'symlink'; path: string; target: string; label: string };

type FileTarget = Exclude<Target, { kind: 'symlink' }>;

type FileEntry = Exclude<ManifestEntry, { kind: 'symlink' }>;

const NONE: Change = { type: 'none' };

const REMOVAL_LABEL = 'no longer selected';
const CHANGED_OUTSIDE = 'changed outside agents-config, left in place';
const NOTHING_LEFT = 'nothing left to remove';

const LOCATION_PROBLEMS = {
  outside: 'resolves outside the project',
  dangling: 'links to a missing location',
} as const;

type LocationProblem = keyof typeof LOCATION_PROBLEMS;

function keyOf(entry: { kind: string; path: string }): string {
  return `${entry.kind}:${entry.path}`;
}

async function locationProblem(
  path: string,
  boundary: string | undefined,
): Promise<LocationProblem | undefined> {
  const real = await realLocation(path);
  if (real === null) return 'dangling';
  if (boundary !== undefined && !isInside(boundary, real)) return 'outside';
  return undefined;
}

function leftInPlace(problem: LocationProblem): string {
  return `${LOCATION_PROBLEMS[problem]}, left in place`;
}

function fileKindProblem(stats: Stats | null): string | undefined {
  if (!stats || stats.isFile()) return undefined;
  return stats.isDirectory() ? 'is a directory' : 'is not a regular file';
}

async function linksTo(link: string, destination: string): Promise<boolean> {
  const target = await readSymlink(link);
  if (target === null) return false;
  const [linked, expected] = await Promise.all([
    realLocation(resolve(dirname(link), target)),
    realLocation(destination),
  ]);
  return linked !== null && linked === expected;
}

function globalTargets(input: PlanInput): Target[] {
  const { selection, paths, library } = input;
  const tools = orderedTools(selection.tools);
  const targets: Target[] = [];

  if (tools.length > 0) {
    const body = composeGlobal(library, selection.blocks, selection.variables);
    const owners = new Map<string, string[]>();
    for (const tool of tools) {
      const path = tool.global.instructions(paths);
      owners.set(path, [...(owners.get(path) ?? []), tool.label]);
    }
    for (const [path, labels] of owners) {
      targets.push({
        kind: 'region',
        path,
        body,
        label: `${labels.join(', ')} instructions`,
      });
    }
    for (const tool of tools) {
      const setting = tool.global.settings?.(paths);
      if (setting) {
        targets.push({
          kind: 'json-array',
          path: setting.file,
          key: setting.key,
          values: setting.values,
          label: `${tool.label} settings`,
        });
      }
    }
  }

  if (selection.linkCommand) {
    targets.push({
      kind: 'symlink',
      path: join(paths.localBin, 'agents-config'),
      target: join(input.repoRoot, 'src', 'cli.ts'),
      label: 'agents-config command',
    });
  }
  return targets;
}

function projectTargets(input: PlanInput): Target[] {
  const { selection, library, project } = input;
  const tools = orderedTools(selection.tools);
  if (!project || tools.length === 0) return [];

  const instructions = join(project.dir, 'AGENTS.md');
  const targets: Target[] = [
    {
      kind: 'region',
      path: instructions,
      body: composeProject(library, selection.blocks, selection.variables),
      preamble: `# ${project.title}`,
      label: 'project instructions',
    },
  ];
  for (const tool of tools) {
    const { importLine, settings } = tool.project;
    if (importLine) {
      targets.push({
        kind: 'line',
        path: join(project.dir, importLine.file),
        line: importLine.line,
        satisfiedBy: instructions,
        label: `${tool.label} import`,
      });
    }
    if (settings) {
      targets.push({
        kind: 'json-array',
        path: join(project.dir, settings.file),
        key: settings.key,
        values: settings.values,
        label: `${tool.label} settings`,
      });
    }
  }

  if (selection.keepLocal && project.git) {
    const { root, excludePath } = project.git;
    const patterns = [
      ...targets.map((target) => target.path),
      input.manifestPath,
    ]
      .map((path) => `/${relative(root, path)}`)
      .join('\n');
    targets.push({
      kind: 'exclude-region',
      path: excludePath,
      id: relative(root, project.dir) || '.',
      body: patterns,
      label: 'git exclude entries',
    });
  }
  return targets;
}

function conflict(
  target: { path: string; label: string },
  previous: ManifestEntry | null,
  reason: string,
): PlannedAction {
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

async function guarded(
  target: { path: string; label: string },
  previous: ManifestEntry | null,
  plan: () => Promise<PlannedAction>,
): Promise<PlannedAction> {
  try {
    return await plan();
  } catch (error) {
    const reason = fsErrorReason(error);
    if (reason === undefined) throw error;
    return conflict(target, previous, reason);
  }
}

function writeAction(
  target: { path: string; label: string },
  file: { writePath: string; existing: string | null },
  next: string,
  entry: ManifestEntry,
  previous: ManifestEntry | null,
): PlannedAction {
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

async function planSymlink(
  target: Extract<Target, { kind: 'symlink' }>,
  previous: ManifestEntry | null,
): Promise<PlannedAction> {
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
  return conflict(
    target,
    previous,
    previous ? CHANGED_OUTSIDE : 'exists and is not managed by agents-config',
  );
}

function wasCreated(existing: string | null, previous: ManifestEntry | null) {
  if (existing === null) return true;
  return previous !== null && 'createdFile' in previous
    ? previous.createdFile
    : false;
}

function regionPreamble(
  target: Extract<FileTarget, { kind: 'region' }>,
  existing: string | null,
  previous: ManifestEntry | null,
): string | undefined {
  if (existing === null) return target.preamble;
  return previous?.kind === 'region' ? previous.preamble : undefined;
}

async function planFile(
  target: FileTarget,
  previous: ManifestEntry | null,
  boundary: string | undefined,
): Promise<PlannedAction> {
  let writePath = target.path;
  const stats = await lstatIfExists(target.path);
  if (stats?.isSymbolicLink()) {
    if (
      target.kind === 'line' &&
      target.satisfiedBy &&
      (await linksTo(target.path, target.satisfiedBy))
    ) {
      return {
        path: target.path,
        label: `${target.label} (links to ${basename(target.satisfiedBy)})`,
        status: 'unchanged',
        change: NONE,
        entry: null,
        previous,
      };
    }
    const resolved = await resolveIfSymlink(target.path);
    if (resolved === null) {
      return conflict(target, previous, 'is a symlink to a missing file');
    }
    writePath = resolved;
  }
  const problem = await locationProblem(
    writePath,
    target.kind === 'exclude-region' ? undefined : boundary,
  );
  if (problem) return conflict(target, previous, leftInPlace(problem));
  const kindProblem = fileKindProblem(await statIfExists(writePath));
  if (kindProblem) return conflict(target, previous, kindProblem);

  const existing = await readTextIfExists(writePath);
  const file = { writePath, existing };
  const createdFile = wasCreated(existing, previous);

  switch (target.kind) {
    case 'region':
    case 'exclude-region': {
      try {
        if (target.kind === 'exclude-region') {
          const next = upsertRegion(existing, target.body, {
            markers: excludeMarkers(target.id),
          });
          const entry: ManifestEntry = {
            kind: 'exclude-region',
            path: target.path,
            id: target.id,
            createdFile,
          };
          return writeAction(target, file, next, entry, previous);
        }
        const next = upsertRegion(existing, target.body, {
          markers: MARKDOWN_MARKERS,
          ...(target.preamble ? { preamble: target.preamble } : {}),
        });
        const preamble = regionPreamble(target, existing, previous);
        const entry: ManifestEntry = {
          kind: 'region',
          path: target.path,
          createdFile,
          ...(preamble ? { preamble } : {}),
        };
        return writeAction(target, file, next, entry, previous);
      } catch (error) {
        if (error instanceof ManagedRegionError) {
          return conflict(target, previous, error.message);
        }
        throw error;
      }
    }
    case 'line': {
      const hadLine = existing !== null && hasLine(existing, target.line);
      const added = hadLine
        ? previous?.kind === 'line' && previous.added
        : true;
      return writeAction(
        target,
        file,
        ensureLine(existing, target.line),
        {
          kind: 'line',
          path: target.path,
          line: target.line,
          added,
          createdFile,
        },
        previous,
      );
    }
    case 'json-array': {
      try {
        const result = ensureArrayValues(
          parseJsonObject(existing),
          target.key,
          target.values,
        );
        const earlier = previous?.kind === 'json-array' ? previous : null;
        const added = [
          ...new Set([
            ...(earlier?.added ?? []).filter((value) =>
              target.values.includes(value),
            ),
            ...result.added,
          ]),
        ];
        const next =
          existing === null || result.added.length > 0
            ? serializeJson(result.doc, existing)
            : existing;
        return writeAction(
          target,
          file,
          next,
          {
            kind: 'json-array',
            path: target.path,
            key: target.key,
            added,
            wasString: earlier?.wasString ?? result.wasString,
            createdFile,
          },
          previous,
        );
      } catch (error) {
        if (error instanceof JsonMergeError) {
          return conflict(target, previous, error.message);
        }
        throw error;
      }
    }
  }
}

function removal(
  entry: ManifestEntry,
  change: Change,
  options: { writePath?: string; reason?: string } = {},
): PlannedAction {
  const untouched = change.type === 'none';
  return {
    path: entry.path,
    ...(options.writePath ? { writePath: options.writePath } : {}),
    label: untouched ? 'no longer tracked' : REMOVAL_LABEL,
    status: untouched ? 'unchanged' : 'remove',
    change,
    entry: null,
    previous: entry,
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

function rewriteOrDelete(
  entry: FileEntry,
  file: { writePath: string; existing: string; viaLink: boolean },
  next: string,
  emptyWhen: (next: string) => boolean,
): PlannedAction {
  const writePath = file.viaLink ? { writePath: file.writePath } : {};
  if (entry.createdFile && !file.viaLink && emptyWhen(next)) {
    return removal(entry, { type: 'delete' });
  }
  if (next === file.existing) {
    return removal(entry, NONE, { ...writePath, reason: NOTHING_LEFT });
  }
  return removal(entry, { type: 'write', content: next }, writePath);
}

async function planRemoval(
  entry: ManifestEntry,
  boundary: string | undefined,
): Promise<PlannedAction> {
  if (entry.kind === 'symlink') {
    if ((await readSymlink(entry.path)) === entry.target) {
      return removal(entry, { type: 'delete' });
    }
    return removal(entry, NONE, { reason: CHANGED_OUTSIDE });
  }

  const conflictTarget = { path: entry.path, label: REMOVAL_LABEL };
  const viaLink = await resolveIfSymlink(entry.path);
  const writePath = viaLink ?? entry.path;
  const problem = await locationProblem(
    writePath,
    entry.kind === 'exclude-region' ? undefined : boundary,
  );
  if (problem) return conflict(conflictTarget, entry, leftInPlace(problem));
  const kindProblem = fileKindProblem(await statIfExists(writePath));
  if (kindProblem) return conflict(conflictTarget, entry, kindProblem);
  const existing = await readTextIfExists(writePath);
  if (existing === null) {
    return removal(entry, NONE, { reason: 'already gone' });
  }
  const file = { writePath, existing, viaLink: viaLink !== null };

  switch (entry.kind) {
    case 'region':
    case 'exclude-region': {
      try {
        const markers =
          entry.kind === 'region' ? MARKDOWN_MARKERS : excludeMarkers(entry.id);
        const preamble = entry.kind === 'region' ? entry.preamble : undefined;
        return rewriteOrDelete(
          entry,
          file,
          removeRegion(existing, markers),
          (next) => next === '' || next.trim() === preamble,
        );
      } catch (error) {
        if (error instanceof ManagedRegionError) {
          return conflict(conflictTarget, entry, error.message);
        }
        throw error;
      }
    }
    case 'line':
      if (!entry.added) {
        return removal(entry, NONE, {
          reason: 'the line was there before agents-config',
        });
      }
      return rewriteOrDelete(
        entry,
        file,
        removeLine(existing, entry.line),
        (next) => next === '',
      );
    case 'json-array': {
      try {
        const before = parseJsonObject(existing);
        const after = removeArrayValues(
          before,
          entry.key,
          entry.added,
          entry.wasString,
        );
        if (JSON.stringify(after) === JSON.stringify(before)) {
          return removal(entry, NONE, { reason: NOTHING_LEFT });
        }
        return rewriteOrDelete(
          entry,
          file,
          serializeJson(after, existing),
          () => Object.keys(after).length === 0,
        );
      } catch (error) {
        if (error instanceof JsonMergeError) {
          return conflict(conflictTarget, entry, error.message);
        }
        throw error;
      }
    }
  }
}

async function checkManifestPath(
  manifestPath: string,
  boundary: string | undefined,
): Promise<void> {
  if ((await lstatIfExists(manifestPath))?.isSymbolicLink()) {
    throw new ManifestError(
      `${manifestPath} is a symlink; replace it with a regular file`,
    );
  }
  const problem = await locationProblem(manifestPath, boundary);
  if (problem) {
    throw new ManifestError(
      `${manifestPath} ${LOCATION_PROBLEMS[problem]}; refusing to record the install there`,
    );
  }
}

export async function buildPlan(input: PlanInput): Promise<Plan> {
  const boundary = input.scope === 'project' ? input.project?.dir : undefined;
  await checkManifestPath(input.manifestPath, boundary);

  const targets =
    input.scope === 'global' ? globalTargets(input) : projectTargets(input);
  const previousEntries = new Map(
    (input.previous?.entries ?? []).map((entry) => [keyOf(entry), entry]),
  );

  const actions: PlannedAction[] = [];
  const planned = new Set<string>();
  for (const target of targets) {
    const key = keyOf(target);
    planned.add(key);
    const previous = previousEntries.get(key) ?? null;
    actions.push(
      await guarded(target, previous, () =>
        target.kind === 'symlink'
          ? planSymlink(target, previous)
          : planFile(target, previous, boundary),
      ),
    );
  }
  for (const [key, entry] of previousEntries) {
    if (planned.has(key)) continue;
    actions.push(
      await guarded({ path: entry.path, label: REMOVAL_LABEL }, entry, () =>
        planRemoval(entry, boundary),
      ),
    );
  }

  const blocks = selectBlocks(
    input.library,
    input.selection.blocks,
    input.scope,
  );
  const variables = Object.fromEntries(
    requiredVariables(blocks).flatMap((name) => {
      const value = input.selection.variables[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const manifest: Omit<Manifest, 'entries'> = {
    version: MANIFEST_VERSION,
    scope: input.scope,
    tools: [...input.selection.tools],
    blocks: blocks.map((block) => block.id),
    variables,
    options:
      input.scope === 'global'
        ? { linkCommand: input.selection.linkCommand }
        : { keepLocal: input.selection.keepLocal },
  };

  const entries = actions.flatMap((action) =>
    action.entry ? [action.entry] : [],
  );
  const existing = await readTextIfExists(input.manifestPath);
  const content = serializeManifest(
    { ...manifest, entries },
    input.project?.dir,
  );
  const empty = entries.length === 0 && manifest.tools.length === 0;
  const manifestStatus: ManifestStatus = empty
    ? existing === null
      ? 'unchanged'
      : 'remove'
    : existing === null
      ? 'create'
      : existing === content
        ? 'unchanged'
        : 'update';

  return {
    actions,
    manifest,
    manifestPath: input.manifestPath,
    manifestStatus,
    ...(input.project ? { projectDir: input.project.dir } : {}),
  };
}
