import { join } from 'node:path';

import { z } from 'zod';

import type { Paths } from '../env.ts';
import { ManifestError } from '../errors.ts';
import { readTextIfExists, writeTextAtomic } from '../install/fs.ts';

const projectsSchema = z.object({ projects: z.array(z.string()) });

export function projectsFile(paths: Paths): string {
  return join(paths.stateDir, 'projects.json');
}

export async function readProjects(paths: Paths): Promise<string[]> {
  const file = projectsFile(paths);
  const content = await readTextIfExists(file);
  if (content === null) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new ManifestError(`${file} is not valid JSON`, { cause: error });
  }
  const result = projectsSchema.safeParse(raw);
  if (!result.success) {
    throw new ManifestError(`${file}: ${z.prettifyError(result.error)}`);
  }
  return result.data.projects;
}

export async function recordProject(
  paths: Paths,
  projectDir: string,
): Promise<void> {
  const projects = await readProjects(paths);
  if (projects.includes(projectDir)) return;
  const next = [...projects, projectDir].sort();
  await writeTextAtomic(
    projectsFile(paths),
    `${JSON.stringify({ projects: next }, null, 2)}\n`,
  );
}
