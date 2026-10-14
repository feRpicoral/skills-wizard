import { isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { SCOPES } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { ManifestError } from '../errors.ts';
import {
  isInside,
  readTextIfExists,
  realLocation,
  statIfExists,
  writeTextAtomic,
} from '../install/fs.ts';
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
    createdKeys: z.number().int().min(0).optional(),
    original: z.string().optional(),
    wasEmpty: z.boolean().optional(),
    blankText: z
      .string()
      .regex(/^[\s\uFEFF]*$/, 'must hold only whitespace')
      .optional(),
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

/**
 * Reads and validates the system-wide manifest at `file`.
 *
 * System-wide entries are used as they are, so relative `path` or symlink
 * `target` values are rejected with {@link ManifestError} rather than resolved
 * against whatever directory the CLI happens to run from.
 */
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

/**
 * Reads and validates a project manifest at `file`, resolving each entry's
 * stored relative path against `dir`.
 *
 * Verifies that `file` itself resolves inside `dir`, rejects absolute entry
 * paths or paths escaping `dir` with {@link ManifestError}, and drops stale
 * `exclude-region` entries whose path no longer matches `gitExcludePath`
 * (returning those dropped paths in `ignored`).
 */
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
