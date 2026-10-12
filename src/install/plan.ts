import { join } from 'node:path';

import {
  composeGlobal,
  composeProject,
  requiredVariables,
  selectBlocks,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import type { Manifest, ManifestEntry } from '../state/manifest.ts';
import { orderedTools, type ToolId } from '../tools/registry.ts';
import { lstatIfExists, readSymlink, readTextIfExists } from './fs.ts';
import { ensureLine, removeLine } from './import-line.ts';
import {
  ensureArrayValues,
  parseJsonObject,
  removeArrayValues,
  serializeJson,
} from './json-merge.ts';
import {
  HASH_MARKERS,
  MARKDOWN_MARKERS,
  removeRegion,
  upsertRegion,
} from './managed-region.ts';

export type ActionStatus =
  'create' | 'update' | 'unchanged' | 'remove' | 'conflict';

export type Change =
  | { type: 'none' }
  | { type: 'write'; content: string }
  | { type: 'delete' }
  | { type: 'symlink'; target: string };

export interface PlannedAction {
  path: string;
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

export interface PlanInput {
  scope: Scope;
  selection: Selection;
  library: BlockLibrary;
  paths: Paths;
  repoRoot: string;
  previous: Manifest | null;
  projectDir?: string;
  projectTitle?: string;
  gitExcludePath?: string;
  manifestPath: string;
  now: Date;
}

export interface Plan {
  scope: Scope;
  actions: PlannedAction[];
  manifest: Manifest;
}

type Target =
  | {
      kind: 'region';
      path: string;
      body: string;
      preamble?: string;
      label: string;
    }
  | { kind: 'exclude-region'; path: string; body: string; label: string }
  | { kind: 'line'; path: string; line: string; label: string }
  | {
      kind: 'json-array';
      path: string;
      key: string;
      values: readonly string[];
      label: string;
    }
  | { kind: 'symlink'; path: string; target: string; label: string };

const NONE: Change = { type: 'none' };

function keyOf(entry: { kind: string; path: string }): string {
  return `${entry.kind}:${entry.path}`;
}

function globalTargets(input: PlanInput): Target[] {
  const { selection, paths, library } = input;
  const tools = orderedTools(selection.tools);
  const targets: Target[] = [];
  if (tools.length === 0 && !selection.linkCommand) return targets;

  if (tools.length > 0) {
    const body = composeGlobal(library, selection.blocks, selection.variables);
    const labels = new Map<string, string[]>();
    for (const tool of tools) {
      const path = tool.global.instructions(paths);
      labels.set(path, [...(labels.get(path) ?? []), tool.label]);
    }
    for (const [path, owners] of labels) {
      targets.push({
        kind: 'region',
        path,
        body,
        label: `${owners.join(', ')} instructions`,
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
  const { selection, library, projectDir } = input;
  const tools = orderedTools(selection.tools);
  if (!projectDir || tools.length === 0) return [];

  const targets: Target[] = [
    {
      kind: 'region',
      path: join(projectDir, 'AGENTS.md'),
      body: composeProject(library, selection.blocks, selection.variables),
      preamble: `# ${input.projectTitle ?? 'Project'}`,
      label: 'project instructions',
    },
  ];
  for (const tool of tools) {
    const { importLine, settings } = tool.project;
    if (importLine) {
      targets.push({
        kind: 'line',
        path: join(projectDir, importLine.file),
        line: importLine.line,
        label: `${tool.label} import`,
      });
    }
    if (settings) {
      targets.push({
        kind: 'json-array',
        path: join(projectDir, settings.file),
        key: settings.key,
        values: settings.values,
        label: `${tool.label} settings`,
      });
    }
  }

  if (selection.keepLocal && input.gitExcludePath) {
    const excluded = [
      ...targets.map((target) => target.path),
      input.manifestPath,
    ]
      .map((path) => `/${path.slice(projectDir.length + 1)}`)
      .join('\n');
    targets.push({
      kind: 'exclude-region',
      path: input.gitExcludePath,
      body: excluded,
      label: 'git exclude entries',
    });
  }
  return targets;
}

function createdFile(existing: string | null, previous: ManifestEntry | null) {
  if (existing === null) return true;
  return previous !== null && 'createdFile' in previous
    ? previous.createdFile
    : false;
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

function writeAction(
  target: { path: string; label: string },
  existing: string | null,
  next: string,
  entry: ManifestEntry,
  previous: ManifestEntry | null,
): PlannedAction {
  const status =
    existing === null ? 'create' : next === existing ? 'unchanged' : 'update';
  return {
    path: target.path,
    label: target.label,
    status,
    change: status === 'unchanged' ? NONE : { type: 'write', content: next },
    entry,
    previous,
  };
}

async function planTarget(
  target: Target,
  previous: ManifestEntry | null,
): Promise<PlannedAction> {
  if (target.kind === 'symlink') {
    const stats = await lstatIfExists(target.path);
    const current = await readSymlink(target.path);
    const entry: ManifestEntry = {
      kind: 'symlink',
      path: target.path,
      target: target.target,
    };
    if (current === target.target) {
      return {
        path: target.path,
        label: target.label,
        status: 'unchanged',
        change: NONE,
        entry,
        previous,
      };
    }
    if (stats && !previous) {
      return conflict(
        target,
        previous,
        'exists and is not managed by agents-config',
      );
    }
    return {
      path: target.path,
      label: target.label,
      status: stats ? 'update' : 'create',
      change: { type: 'symlink', target: target.target },
      entry,
      previous,
    };
  }

  const existing = await readTextIfExists(target.path);
  const created = createdFile(existing, previous);

  switch (target.kind) {
    case 'region':
    case 'exclude-region': {
      const markers =
        target.kind === 'region' ? MARKDOWN_MARKERS : HASH_MARKERS;
      try {
        const next = upsertRegion(existing, target.body, {
          markers,
          ...(target.kind === 'region' && target.preamble
            ? { preamble: target.preamble }
            : {}),
        });
        return writeAction(
          target,
          existing,
          next,
          { kind: target.kind, path: target.path, createdFile: created },
          previous,
        );
      } catch (error) {
        if (error instanceof ManagedRegionError) {
          return conflict(target, previous, error.message);
        }
        throw error;
      }
    }
    case 'line':
      return writeAction(
        target,
        existing,
        ensureLine(existing, target.line),
        {
          kind: 'line',
          path: target.path,
          line: target.line,
          createdFile: created,
        },
        previous,
      );
    case 'json-array': {
      try {
        const doc = parseJsonObject(existing, target.path);
        const result = ensureArrayValues(
          doc,
          target.key,
          target.values,
          target.path,
        );
        const previouslyAdded =
          previous?.kind === 'json-array' ? previous.added : [];
        const added = [
          ...new Set([
            ...previouslyAdded.filter((value) => target.values.includes(value)),
            ...result.added,
          ]),
        ];
        const next =
          existing === null || result.added.length > 0
            ? serializeJson(result.doc)
            : existing;
        return writeAction(
          target,
          existing,
          next,
          {
            kind: 'json-array',
            path: target.path,
            key: target.key,
            added,
            createdFile: created,
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
  label: string,
  change: Change,
  reason?: string,
): PlannedAction {
  return {
    path: entry.path,
    label,
    status: 'remove',
    change,
    entry: null,
    previous: entry,
    ...(reason ? { reason } : {}),
  };
}

function removeOrRewrite(
  entry: ManifestEntry & { createdFile: boolean },
  existing: string,
  next: string,
  label: string,
): PlannedAction {
  if (next === '' && entry.createdFile) {
    return removal(entry, label, { type: 'delete' });
  }
  if (next === existing) return removal(entry, label, NONE);
  return removal(entry, label, { type: 'write', content: next });
}

async function planRemoval(entry: ManifestEntry): Promise<PlannedAction> {
  const label = 'no longer selected';

  if (entry.kind === 'symlink') {
    const current = await readSymlink(entry.path);
    if (current === entry.target) {
      return removal(entry, label, { type: 'delete' });
    }
    return removal(
      entry,
      label,
      NONE,
      'changed outside agents-config, left in place',
    );
  }

  const existing = await readTextIfExists(entry.path);
  if (existing === null) return removal(entry, label, NONE);

  switch (entry.kind) {
    case 'region':
    case 'exclude-region': {
      const markers = entry.kind === 'region' ? MARKDOWN_MARKERS : HASH_MARKERS;
      try {
        return removeOrRewrite(
          entry,
          existing,
          removeRegion(existing, markers),
          label,
        );
      } catch (error) {
        if (error instanceof ManagedRegionError) {
          return conflict({ path: entry.path, label }, entry, error.message);
        }
        throw error;
      }
    }
    case 'line':
      return removeOrRewrite(
        entry,
        existing,
        removeLine(existing, entry.line),
        label,
      );
    case 'json-array': {
      try {
        const before = parseJsonObject(existing, entry.path);
        const after = removeArrayValues(
          before,
          entry.key,
          entry.added,
          entry.path,
        );
        if (serializeJson(after) === serializeJson(before)) {
          return removal(entry, label, NONE);
        }
        if (Object.keys(after).length === 0 && entry.createdFile) {
          return removal(entry, label, { type: 'delete' });
        }
        return removal(entry, label, {
          type: 'write',
          content: serializeJson(after),
        });
      } catch (error) {
        if (error instanceof JsonMergeError) {
          return conflict({ path: entry.path, label }, entry, error.message);
        }
        throw error;
      }
    }
  }
}

export async function buildPlan(input: PlanInput): Promise<Plan> {
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
    actions.push(await planTarget(target, previousEntries.get(key) ?? null));
  }
  for (const [key, entry] of previousEntries) {
    if (!planned.has(key)) actions.push(await planRemoval(entry));
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

  return {
    scope: input.scope,
    actions,
    manifest: {
      version: 1,
      scope: input.scope,
      tools: [...input.selection.tools],
      blocks: blocks.map((block) => block.id),
      variables,
      options:
        input.scope === 'global'
          ? { linkCommand: input.selection.linkCommand }
          : { keepLocal: input.selection.keepLocal },
      entries: actions.flatMap((action) =>
        action.entry ? [action.entry] : [],
      ),
      updatedAt: input.now.toISOString(),
    },
  };
}
