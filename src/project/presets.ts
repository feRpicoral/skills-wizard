import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { defaultBlockIds } from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import { PresetError } from '../errors.ts';
import { isDirectory } from '../install/fs.ts';
import { promptPreset, promptProjectStyle } from '../prompts/selection.ts';
import type { SkillLibrary } from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import type { DetectedPackageManager, ProjectDetection } from './detect.ts';

export const PRESET_IDS = [
  'nextjs-app',
  'nestjs-api',
  'nx-monorepo',
  'expo-app',
  'vite-spa',
  'python-service',
  'node-tool',
] as const;

export type PresetId = (typeof PRESET_IDS)[number];

export type PresetChoice = PresetId | 'none';

export const PROJECT_STYLES = ['lean', 'self-contained'] as const;

export type ProjectStyle = (typeof PROJECT_STYLES)[number];

const presetSchema = z.strictObject({
  id: z.enum(PRESET_IDS),
  name: z.string().min(1),
  description: z.string().min(1),
  blocks: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
});

export type PresetDefinition = z.infer<typeof presetSchema>;

export interface PresetLibraries {
  blockLibrary?: BlockLibrary;
  skillLibrary?: SkillLibrary;
}

export interface ResolvePresetSelectionParams {
  preset?: PresetDefinition;
  style: ProjectStyle;
  blockLibrary: BlockLibrary;
  skillLibrary?: SkillLibrary;
  packageManager?: DetectedPackageManager;
  detectedBlocks?: readonly string[];
  detectedSkills?: readonly string[];
}

export interface ResolvedPresetSelection {
  blocks: string[];
  skills: string[];
}

interface ParsePresetParams {
  source: string;
  file: string;
  expectedId: string;
}

export function presetsPath(repoRoot: string): string {
  return join(repoRoot, 'presets');
}

export function isPresetId(value: string): value is PresetId {
  return (PRESET_IDS as readonly string[]).includes(value);
}

export function isPresetChoice(value: string): value is PresetChoice {
  return value === 'none' || isPresetId(value);
}

export function isProjectStyle(value: string): value is ProjectStyle {
  return (PROJECT_STYLES as readonly string[]).includes(value);
}

function parsePreset({
  source,
  file,
  expectedId,
}: ParsePresetParams): PresetDefinition {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new PresetError(`${file}: invalid YAML`, { cause: error });
  }
  const result = presetSchema.safeParse(raw);
  if (!result.success) {
    throw new PresetError(`${file}: ${z.prettifyError(result.error)}`);
  }
  if (result.data.id !== expectedId) {
    throw new PresetError(
      `${file}: preset id "${result.data.id}" must match filename "${expectedId}"`,
    );
  }
  return result.data;
}

function validatePresetReferences(
  preset: PresetDefinition,
  file: string,
  libraries: PresetLibraries,
): void {
  if (libraries.blockLibrary) {
    const byId = new Map(
      libraries.blockLibrary.blocks.map((block) => [block.id, block]),
    );
    for (const blockId of preset.blocks) {
      const block = byId.get(blockId);
      if (!block) {
        throw new PresetError(`${file}: unknown block "${blockId}"`);
      }
      if (!block.scopes.includes('project')) {
        throw new PresetError(
          `${file}: block "${blockId}" is not available for project scope`,
        );
      }
    }
  }
  if (libraries.skillLibrary) {
    const byName = new Map(
      libraries.skillLibrary.skills.map((skill) => [skill.name, skill]),
    );
    for (const skillName of preset.skills) {
      const skill = byName.get(skillName);
      if (!skill) {
        throw new PresetError(`${file}: unknown skill "${skillName}"`);
      }
      if (!skill.scopes.includes('project')) {
        throw new PresetError(
          `${file}: skill "${skillName}" is not available for project scope`,
        );
      }
    }
  }
}

/**
 * Loads and validates all stack preset YAML definitions from `presetsDir` in
 * canonical `PRESET_IDS` order, optionally cross-checking block and skill
 * references against `libraries` for existence and `project` scope support.
 *
 * Throws `PresetError` if the directory cannot be read, any YAML file is
 * malformed or fails schema/reference validation, or any preset in `PRESET_IDS`
 * is missing.
 */
export async function loadPresets(
  presetsDir: string,
  libraries: PresetLibraries = {},
): Promise<PresetDefinition[]> {
  let entries;
  try {
    entries = await readdir(presetsDir, { withFileTypes: true });
  } catch (error) {
    throw new PresetError(`${presetsDir}: unable to read presets directory`, {
      cause: error,
    });
  }

  const yamlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name)
    .sort();

  const byId = new Map<PresetId, PresetDefinition>();
  for (const name of yamlFiles) {
    const expectedId = name.slice(0, -'.yaml'.length);
    const file = join(presetsDir, name);
    const source = await readFile(file, 'utf8');
    const preset = parsePreset({ source, file, expectedId });
    validatePresetReferences(preset, file, libraries);
    byId.set(preset.id, preset);
  }

  const missing = PRESET_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new PresetError(
      `${presetsDir}: missing presets: ${missing.join(', ')}`,
    );
  }

  return PRESET_IDS.map((id) => byId.get(id)!);
}

export async function loadPresetsIfAvailable(
  repoRoot: string,
  libraries: PresetLibraries,
): Promise<PresetDefinition[]> {
  const dir = presetsPath(repoRoot);
  if (!(await isDirectory(dir))) return [];
  return loadPresets(dir, libraries);
}

export function findPreset(
  presets: readonly PresetDefinition[],
  id: PresetChoice | undefined,
): PresetDefinition | undefined {
  if (!id || id === 'none') return undefined;
  return presets.find((preset) => preset.id === id);
}

const NON_YARN_NODE_MANAGERS: ReadonlySet<DetectedPackageManager> = new Set([
  'npm',
  'pnpm',
  'bun',
]);

/**
 * Resolves the project block and skill selection for a stack `preset`,
 * `style` (`lean` vs `self-contained`), detected `packageManager` (omitting
 * `stack/node-yarn` for non-Yarn Node managers), and additive `detectedBlocks` /
 * `detectedSkills`.
 *
 * Returned `blocks` are ordered according to `blockLibrary.blocks` and filtered
 * to `project` scope; returned `skills` preserve preset-then-detected order
 * without duplicates.
 */
export function resolvePresetSelection({
  preset,
  style,
  blockLibrary,
  skillLibrary,
  packageManager,
  detectedBlocks = [],
  detectedSkills = [],
}: ResolvePresetSelectionParams): ResolvedPresetSelection {
  const wantedBlocks = new Set<string>();
  if (style === 'self-contained') {
    for (const block of blockLibrary.blocks) {
      if (
        block.defaults.includes('project') &&
        block.scopes.includes('project')
      ) {
        wantedBlocks.add(block.id);
      }
    }
  }
  for (const blockId of preset?.blocks ?? []) {
    if (
      blockId === 'stack/node-yarn' &&
      packageManager !== undefined &&
      NON_YARN_NODE_MANAGERS.has(packageManager)
    ) {
      continue;
    }
    wantedBlocks.add(blockId);
  }
  for (const blockId of detectedBlocks) {
    wantedBlocks.add(blockId);
  }

  const blocks = blockLibrary.blocks
    .filter(
      (block) => block.scopes.includes('project') && wantedBlocks.has(block.id),
    )
    .map((block) => block.id);

  const allowedSkills = skillLibrary
    ? new Set(
        skillLibrary.skills
          .filter((skill) => skill.scopes.includes('project'))
          .map((skill) => skill.name),
      )
    : null;
  const skills: string[] = [];
  for (const skillName of [...(preset?.skills ?? []), ...detectedSkills]) {
    if (allowedSkills && !allowedSkills.has(skillName)) continue;
    if (!skills.includes(skillName)) {
      skills.push(skillName);
    }
  }

  return { blocks, skills };
}

export interface ResolveProjectPresetParams {
  scope: Scope;
  prompting: boolean;
  hasGlobalInstall: boolean;
  presets: readonly PresetDefinition[];
  detection: ProjectDetection | undefined;
  previous: Manifest | null;
  previousPreset: PresetChoice | undefined;
  requestedPreset: PresetChoice | undefined;
  requestedStyle: ProjectStyle | undefined;
  prompts?: {
    promptPreset?: typeof promptPreset;
    promptProjectStyle?: typeof promptProjectStyle;
  };
}

/**
 * Determines the effective project `preset` (`PresetId | 'none'`) and `style`
 * (`lean` | `self-contained`) during `init`, combining explicit CLI flags,
 * recorded manifest options, interactive prompts, and auto-detection.
 */
export async function resolveProjectPresetAndStyle({
  scope,
  prompting,
  hasGlobalInstall,
  presets,
  detection,
  previous,
  previousPreset,
  requestedPreset,
  requestedStyle,
  prompts,
}: ResolveProjectPresetParams): Promise<{
  preset: PresetChoice | undefined;
  style: ProjectStyle | undefined;
}> {
  if (scope !== 'project') {
    return { preset: undefined, style: undefined };
  }
  const askPreset = prompts?.promptPreset ?? promptPreset;
  const askStyle = prompts?.promptProjectStyle ?? promptProjectStyle;

  let preset: PresetChoice | undefined;
  if (requestedPreset !== undefined) {
    preset = requestedPreset;
  } else if (prompting && presets.length > 0) {
    preset = await askPreset(
      presets,
      previousPreset ?? detection?.preset,
      detection?.preset,
    );
  } else if (previous !== null) {
    preset = previousPreset;
  } else if (presets.length > 0) {
    preset = detection?.preset;
  }

  const hasAdditive =
    (detection?.detectedBlocks.length ?? 0) > 0 ||
    (detection?.detectedSkills.length ?? 0) > 0;
  const defaultStyle: ProjectStyle = hasGlobalInstall
    ? 'lean'
    : 'self-contained';
  let style: ProjectStyle | undefined;
  if (requestedStyle !== undefined) {
    style = requestedStyle;
  } else if (prompting) {
    style = await askStyle(previous?.options.style ?? defaultStyle);
  } else if (previous !== null) {
    style = previous.options.style;
  } else if ((preset !== undefined && preset !== 'none') || hasAdditive) {
    style = defaultStyle;
  }

  return { preset, style };
}

export interface ApplyReRunPresetAndStyleParams {
  library: BlockLibrary;
  recordedBlocks: readonly string[];
  previousPresetBlocks?: readonly string[];
  presetBlocks: readonly string[];
  requestedStyle: ProjectStyle | undefined;
}

/**
 * Updates a previously recorded project block list when `init` is re-run with
 * `--preset` and/or `--style`, removing blocks that belonged exclusively to a
 * replaced preset, toggling project-default blocks for `lean` vs
 * `self-contained`, and preserving custom user-selected blocks in library order.
 */
export function applyReRunPresetAndStyle({
  library,
  recordedBlocks,
  previousPresetBlocks = [],
  presetBlocks,
  requestedStyle,
}: ApplyReRunPresetAndStyleParams): string[] {
  const projectDefaults = new Set(defaultBlockIds(library, 'project'));
  const wanted = new Set(recordedBlocks);
  for (const id of previousPresetBlocks) {
    wanted.delete(id);
  }
  if (requestedStyle === 'lean') {
    for (const id of projectDefaults) {
      wanted.delete(id);
    }
  } else if (requestedStyle === 'self-contained') {
    for (const id of projectDefaults) {
      wanted.add(id);
    }
  }
  for (const id of presetBlocks) {
    wanted.add(id);
  }
  return library.blocks
    .filter((block) => block.scopes.includes('project') && wanted.has(block.id))
    .map((block) => block.id);
}

export interface ApplyReRunPresetSkillsParams {
  recordedSkills: readonly string[];
  previousPresetSkills?: readonly string[];
  presetSkills: readonly string[];
}

/**
 * Updates a previously recorded project skill list when `init` is re-run with a
 * new `--preset`, removing skills from the replaced preset while preserving any
 * custom skills the user selected.
 */
export function applyReRunPresetSkills({
  recordedSkills,
  previousPresetSkills = [],
  presetSkills,
}: ApplyReRunPresetSkillsParams): string[] {
  const removed = new Set(previousPresetSkills);
  const kept = recordedSkills.filter((skill) => !removed.has(skill));
  return [...new Set([...kept, ...presetSkills])];
}
