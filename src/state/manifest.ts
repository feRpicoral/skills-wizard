import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { SCOPES } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { ManifestError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';
import { TOOL_IDS } from '../tools/registry.ts';

export const MANIFEST_VERSION = 1;

const pathField = z.string().min(1);

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
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('symlink'),
    path: pathField,
    target: pathField,
  }),
]);

export type ManifestEntry = z.infer<typeof entrySchema>;

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  scope: z.enum(SCOPES),
  tools: z.array(z.enum(TOOL_IDS)),
  blocks: z.array(z.string()),
  variables: z.record(z.string(), z.string()),
  options: z
    .object({
      linkCommand: z.boolean().optional(),
      keepLocal: z.boolean().optional(),
    })
    .default({}),
  entries: z.array(entrySchema),
});

export type Manifest = z.infer<typeof manifestSchema>;

export interface ProjectBase {
  dir: string;
  gitExcludePath?: string;
}

export function globalManifestPath(paths: Paths): string {
  return join(paths.stateDir, 'manifest.json');
}

export function projectManifestPath(projectDir: string): string {
  return join(projectDir, '.agents', 'agents-config.json');
}

function isInside(dir: string, path: string): boolean {
  return path.startsWith(`${dir}${sep}`);
}

function resolveProjectEntry(
  file: string,
  entry: ManifestEntry,
  project: ProjectBase,
): ManifestEntry {
  if (isAbsolute(entry.path)) {
    throw new ManifestError(`${file}: entry paths must be relative`);
  }
  const path = resolve(project.dir, entry.path);
  if (entry.kind === 'exclude-region') {
    if (path !== project.gitExcludePath) {
      throw new ManifestError(
        `${file}: the git exclude entry does not belong to this repository`,
      );
    }
  } else if (!isInside(project.dir, path)) {
    throw new ManifestError(`${file}: ${entry.path} is outside the project`);
  }
  return { ...entry, path };
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

export async function readManifest(
  file: string,
  project?: ProjectBase,
): Promise<Manifest | null> {
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

  if (!project) return result.data;
  return {
    ...result.data,
    entries: result.data.entries.map((entry) =>
      resolveProjectEntry(file, entry, project),
    ),
  };
}

export async function writeManifest(
  file: string,
  manifest: Manifest,
  projectDir?: string,
): Promise<void> {
  await writeTextAtomic(file, serializeManifest(manifest, projectDir));
}
