import { requiredVariables, selectBlocks } from '../blocks/compose.ts';
import {
  type Manifest,
  MANIFEST_VERSION,
  type ManifestEntry,
  serializeManifest,
} from '../state/manifest.ts';
import { readTextIfExists } from './fs.ts';
import type { PlannedAction } from './safety.ts';
import type { PlanInput } from './targets.ts';

export type ManifestStatus = 'create' | 'update' | 'unchanged' | 'remove';

export type ComposeManifestMetadataParams = Pick<
  PlanInput,
  'scope' | 'selection' | 'library'
>;

export function composeManifestMetadata({
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
  const installedSkills = new Set(
    entries.flatMap((entry) => (entry.kind === 'skill' ? [entry.name] : [])),
  );
  const unappliedSkills = new Set(
    actions.flatMap((action) =>
      action.skill !== undefined &&
      !isApplied(action) &&
      !installedSkills.has(action.skill)
        ? [action.skill]
        : [],
    ),
  );
  const skills = [
    ...manifest.skills.filter((name) => !unappliedSkills.has(name)),
    ...[...installedSkills].filter((name) => !manifest.skills.includes(name)),
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

export interface ResolveManifestStatusParams {
  manifest: Omit<Manifest, 'entries'>;
  entries: ManifestEntry[];
  manifestPath: string;
  projectDir?: string;
}

export async function resolveManifestStatus({
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
