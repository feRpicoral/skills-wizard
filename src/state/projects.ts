import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import type { Paths } from '../env.ts';
import { RegistryError } from '../errors.ts';
import {
  readTextIfExists,
  removePath,
  writeTextAtomic,
} from '../install/fs.ts';

const REGISTRY_VERSION = 1;

const registrySchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  projects: z.array(z.string().refine(isAbsolute, 'must be an absolute path')),
});

function registryPath(paths: Paths): string {
  return join(paths.stateDir, 'projects.json');
}

export async function readProjects(paths: Paths): Promise<string[]> {
  const file = registryPath(paths);
  const content = await readTextIfExists(file);

  if (content === null) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new RegistryError(`${file} is not valid JSON`, { cause: error });
  }

  const result = registrySchema.safeParse(raw);
  if (!result.success) {
    throw new RegistryError(`${file}: ${z.prettifyError(result.error)}`);
  }

  return result.data.projects;
}

async function writeProjects(paths: Paths, projects: string[]): Promise<void> {
  const file = registryPath(paths);

  if (projects.length === 0) {
    await removePath(file);
    return;
  }

  await writeTextAtomic({
    path: file,
    content: `${JSON.stringify({ version: REGISTRY_VERSION, projects }, null, 2)}\n`,
  });
}

export async function recordProject(paths: Paths, dir: string): Promise<void> {
  const projects = await readProjects(paths);

  if (projects.includes(dir)) return;
  await writeProjects(paths, [...projects, dir].sort());
}

export async function forgetProject(paths: Paths, dir: string): Promise<void> {
  const projects = await readProjects(paths);

  if (!projects.includes(dir)) return;
  await writeProjects(
    paths,
    projects.filter((project) => project !== dir),
  );
}
