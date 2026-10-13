import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import type { BlockLibrary } from '../blocks/library.ts';
import { PresetError } from '../errors.ts';
import type { SkillLibrary } from '../skills/library.ts';

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

export function findPreset(
  presets: readonly PresetDefinition[],
  id: PresetId,
): PresetDefinition | undefined {
  return presets.find((preset) => preset.id === id);
}

export function resolvePresetSelection({
  preset,
  style,
  blockLibrary,
  skillLibrary,
  detectedBlocks = [],
  detectedSkills = [],
}: ResolvePresetSelectionParams): ResolvedPresetSelection {
  const wantedBlocks = new Set<string>();
  if (style === 'self-contained') {
    for (const block of blockLibrary.blocks) {
      if (
        block.defaults.includes('global') &&
        block.scopes.includes('project')
      ) {
        wantedBlocks.add(block.id);
      }
    }
  }
  for (const blockId of preset?.blocks ?? []) {
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
