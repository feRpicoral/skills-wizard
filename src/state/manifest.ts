import { isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { SCOPES } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { ManifestError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';
import { TOOL_IDS } from '../tools/registry.ts';

const pathField = z.string().min(1);

export const manifestEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('region'),
    path: pathField,
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('exclude-region'),
    path: pathField,
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('line'),
    path: pathField,
    line: z.string().min(1),
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('json-array'),
    path: pathField,
    key: z.string().min(1),
    added: z.array(z.string()),
    createdFile: z.boolean(),
  }),
  z.object({
    kind: z.literal('symlink'),
    path: pathField,
    target: pathField,
  }),
]);

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

const manifestSchema = z.object({
  version: z.literal(1),
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
  entries: z.array(manifestEntrySchema),
  updatedAt: z.string(),
});

export type Manifest = z.infer<typeof manifestSchema>;

export function globalManifestPath(paths: Paths): string {
  return join(paths.stateDir, 'manifest.json');
}

export function projectManifestPath(projectDir: string): string {
  return join(projectDir, '.agents', 'agents-config.json');
}

function mapPaths(
  manifest: Manifest,
  convert: (path: string) => string,
): Manifest {
  return {
    ...manifest,
    entries: manifest.entries.map((entry) => ({
      ...entry,
      path: convert(entry.path),
    })),
  };
}

export async function readManifest(
  file: string,
  baseDir?: string,
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

  if (!baseDir) return result.data;
  return mapPaths(result.data, (path) =>
    isAbsolute(path) ? path : resolve(baseDir, path),
  );
}

export async function writeManifest(
  file: string,
  manifest: Manifest,
  baseDir?: string,
): Promise<void> {
  const stored = baseDir
    ? mapPaths(manifest, (path) => relative(baseDir, path))
    : manifest;
  await writeTextAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
}
