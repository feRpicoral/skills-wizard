import { dirname, join, posix } from 'node:path';

import { z } from 'zod';

import type { Paths } from '../env.ts';
import { readTextIfExists } from '../install/fs.ts';
import { isRepository, isRepositoryPath, WHOLE_REPOSITORY } from './catalog.ts';
import { SKILL_FILE } from './validate.ts';

const LOCK_FILE = '.skill-lock.json';

const lockSchema = z.looseObject({
  skills: z.record(
    z.string(),
    z.looseObject({
      source: z.string().optional(),
      sourceType: z.string().optional(),
      skillPath: z.string().optional(),
    }),
  ),
});

export interface LockedSkill {
  repo?: string;
  path?: string;
}

export function skillLockPath(paths: Paths): string {
  return join(dirname(paths.skillsDir), LOCK_FILE);
}

function skillFolder(skillPath: string | undefined): string | null {
  if (!skillPath) return WHOLE_REPOSITORY;
  if (skillPath.includes('\\')) return null;

  const file = posix.normalize(skillPath);
  if (posix.basename(file) !== SKILL_FILE) return null;

  const folder = posix.dirname(file);
  return isRepositoryPath(folder) ? folder : null;
}

function upstreamOf(
  entry: z.infer<typeof lockSchema>['skills'][string],
): LockedSkill {
  if (
    entry.sourceType !== 'github' ||
    !entry.source ||
    !isRepository(entry.source)
  ) {
    return {};
  }

  const folder = skillFolder(entry.skillPath);
  if (folder === null) return {};

  return { repo: entry.source, path: folder };
}

export async function readSkillLock(
  paths: Paths,
): Promise<Map<string, LockedSkill>> {
  const content = await readTextIfExists(skillLockPath(paths));
  if (content === null) return new Map();

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return new Map();
  }

  const result = lockSchema.safeParse(raw);
  if (!result.success) return new Map();

  return new Map(
    Object.entries(result.data.skills).map(([name, entry]) => [
      name,
      upstreamOf(entry),
    ]),
  );
}
