import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import { z } from 'zod';

import { type Scope, SCOPES } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { ManifestError } from '../errors.ts';
import {
  isInside,
  readTextIfExists,
  realLocation,
  statIfExists,
  writeTextAtomic,
} from '../install/fs.ts';
import { SKILL_MODES } from '../skills/install.ts';
import { isSkillName } from '../skills/validate.ts';
import { TOOL_IDS } from '../tools/registry.ts';

export const MANIFEST_VERSION = 1;

const pathField = z.string().min(1);

const skillName = z.string().refine(isSkillName, 'must be a valid skill name');

const skillSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('catalog'),
    repo: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().min(1).optional(),
    commit: z.string().min(1),
  }),
  z.object({ type: z.literal('local'), path: z.string().min(1) }),
]);

export type SkillSourceRecord = z.infer<typeof skillSourceSchema>;

const skillInstallSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('copy'),
    hash: z.string().min(1),
    setup: z.boolean().optional(),
  }),
  z.object({ mode: z.literal('link'), target: pathField }),
]);

const entrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('region'),
    path: pathField,
    createdFile: z.boolean(),
    preamble: z.string().optional(),
  }),
  z.object({
    kind: z.literal('exclude-region'),
    path: pathField,
    id: z.string().min(1),
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('line'),
    path: pathField,
    line: z.string().min(1),
    added: z.boolean(),
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('json-array'),
    path: pathField,
    key: z.string().min(1),
    added: z.array(z.string()),
    wasString: z.boolean(),
    createdKeys: z.number().int().min(0).optional(),
    original: z.string().optional(),
    wasEmpty: z.boolean().optional(),
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('symlink'),
    path: pathField,
    target: pathField,
  }),
  z.object({
    kind: z.literal('skill'),
    path: pathField,
    name: skillName,
    source: skillSourceSchema,
    install: skillInstallSchema,
  }),
]);

export type ManifestEntry = z.infer<typeof entrySchema>;

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  scope: z.enum(SCOPES),
  tools: z.array(z.enum(TOOL_IDS)),
  blocks: z.array(z.string()),
  skills: z.array(skillName).default([]),
  variables: z.record(z.string(), z.string()),
  options: z
    .object({
      linkCommand: z.boolean().optional(),
      keepLocal: z.boolean().optional(),
      skillMode: z.enum(SKILL_MODES).optional(),
    })
    .default({}),
  entries: z.array(entrySchema),
});

export type Manifest = z.infer<typeof manifestSchema>;

interface ProjectBase {
  dir: string;
  gitExcludePath?: string;
}

interface ProjectManifest {
  manifest: Manifest;
  ignored: string[];
}

export function globalManifestPath(paths: Paths): string {
  return join(paths.stateDir, 'manifest.json');
}

export function projectManifestPath(projectDir: string): string {
  return join(projectDir, '.agents', 'agents-config.json');
}

function resolveProjectEntry(
  file: string,
  entry: ManifestEntry,
  { dir, gitExcludePath }: ProjectBase,
): ManifestEntry | null {
  if (isAbsolute(entry.path)) {
    throw new ManifestError(`${file}: entry paths must be relative`);
  }
  const path = resolve(dir, entry.path);
  if (entry.kind === 'exclude-region') {
    return path === gitExcludePath ? { ...entry, path } : null;
  }
  if (!isInside({ dir, path })) {
    throw new ManifestError(`${file}: ${entry.path} is outside the project`);
  }
  return { ...entry, path };
}

export interface SkillFolders {
  copies: string;
  links: readonly string[];
}

interface CheckSkillEntriesParams {
  file: string;
  entries: readonly ManifestEntry[];
  folders: SkillFolders;
  scope: Scope;
}

export function checkSkillEntries({
  file,
  entries,
  folders,
  scope,
}: CheckSkillEntriesParams): void {
  for (const entry of entries) {
    if (entry.kind === 'skill') {
      const expected = join(folders.copies, entry.name);
      if (entry.path !== expected) {
        throw new ManifestError(
          `${file}: the ${entry.name} skill must be recorded at ${expected}, not ${entry.path}`,
        );
      }
    }
    if (entry.kind === 'symlink') {
      const inSkillsFolder = folders.links.includes(dirname(entry.path));
      if (!inSkillsFolder && scope === 'global') continue;
      if (!inSkillsFolder || !isSkillName(basename(entry.path))) {
        throw new ManifestError(
          `${file}: ${entry.path} is not a skill link in a tool skills folder`,
        );
      }
    }
  }
}

export function serializeManifest(
  manifest: Manifest,
  projectDir?: string,
): string {
  const stored = projectDir
    ? {
        ...manifest,
        entries: manifest.entries.map((entry) => ({
          ...entry,
          path: relative(projectDir, entry.path),
        })),
      }
    : manifest;
  return `${JSON.stringify(stored, null, 2)}\n`;
}

export async function readManifest(file: string): Promise<Manifest | null> {
  const stats = await statIfExists(file);
  if (stats && !stats.isFile()) {
    throw new ManifestError(`${file} is not a regular file`);
  }
  const content = await readTextIfExists(file);
  if (content === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new ManifestError(`${file} is not valid JSON`, { cause: error });
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestError(`${file}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// System-wide entries are used as they are, so a relative path would resolve
// against whatever directory the CLI runs from.
export async function readGlobalManifest(
  file: string,
): Promise<Manifest | null> {
  const manifest = await readManifest(file);
  for (const entry of manifest?.entries ?? []) {
    if (!isAbsolute(entry.path)) {
      throw new ManifestError(
        `${file}: entry paths must be absolute, got ${entry.path}`,
      );
    }
    if (entry.kind === 'symlink' && !isAbsolute(entry.target)) {
      throw new ManifestError(
        `${file}: symlink targets must be absolute, got ${entry.target}`,
      );
    }
  }
  return manifest;
}

export async function readProjectManifest(
  file: string,
  { dir, ...rest }: ProjectBase,
): Promise<ProjectManifest | null> {
  const location = await realLocation(file);
  if (location !== null && !isInside({ dir, path: location })) {
    throw new ManifestError(`${file} resolves outside the project`);
  }
  const manifest = await readManifest(file);
  if (!manifest) return null;

  const ignored: string[] = [];
  const entries = manifest.entries.flatMap((entry) => {
    const resolved = resolveProjectEntry(file, entry, { dir, ...rest });
    if (resolved) return [resolved];
    ignored.push(entry.path);
    return [];
  });
  return { manifest: { ...manifest, entries }, ignored };
}

interface WriteManifestParams {
  file: string;
  manifest: Manifest;
  projectDir?: string;
}

export async function writeManifest({
  file,
  manifest,
  projectDir,
}: WriteManifestParams): Promise<void> {
  await writeTextAtomic({
    path: file,
    content: serializeManifest(manifest, projectDir),
  });
}
