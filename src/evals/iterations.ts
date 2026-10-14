import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { EvalError } from '../errors.ts';
import { isDirectory, lstatIfExists, statIfExists } from '../install/fs.ts';

const MAX_ITERATION_ATTEMPTS = 1000;

// Gives the owner write and search permission on every folder below `path`,
// so folders the agent made read-only can be removed. Best effort.
async function makeTreeWritable(path: string): Promise<void> {
  const info = await lstatIfExists(path);
  if (!info?.isDirectory()) return;

  try {
    await chmod(path, (info.mode & 0o7777) | 0o700);

    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeTreeWritable(join(path, entry.name));
    }
  } catch {
    // Not ours to change; the retry below reports what is left.
  }
}

export interface RemoveWorkdirParams {
  path: string;
  onLog?: (line: string) => void;
}

// Agents can leave read-only folders behind. Cleanup must not turn a graded
// run into a fatal error, so a workdir that cannot be removed is left with a
// warning.
export async function removeWorkdir({
  path,
  onLog,
}: RemoveWorkdirParams): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch {
    await makeTreeWritable(path);
  }

  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onLog?.(
      `warning: could not remove workdir ${path} (${reason}); left it in place`,
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export interface AllocateIterationDirParams {
  evalsRootDir: string;
  skillName: string;
  prefix?: string;
}

// The final mkdir is not recursive, so two evals started together never share
// a directory: the loser gets EEXIST and moves on to the next number.
export async function allocateIterationDir({
  evalsRootDir,
  skillName,
  prefix = 'iteration',
}: AllocateIterationDirParams): Promise<string> {
  const skillEvalsDir = join(evalsRootDir, skillName);
  await mkdir(skillEvalsDir, { recursive: true });

  const numbers = await iterationNumbers({ dir: skillEvalsDir, prefix });
  let candidate = (numbers[0] ?? 0) + 1;

  for (let attempt = 0; attempt < MAX_ITERATION_ATTEMPTS; attempt += 1) {
    const iterationDir = join(skillEvalsDir, `${prefix}-${candidate}`);
    try {
      await mkdir(iterationDir);
      return iterationDir;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      candidate += 1;
    }
  }

  throw new EvalError(
    `Could not allocate a new ${prefix} directory in ${skillEvalsDir}`,
  );
}

interface IterationNumbersParams {
  dir: string;
  prefix: string;
}

/** Iteration numbers found in `dir`, highest first. */
async function iterationNumbers({
  dir,
  prefix,
}: IterationNumbersParams): Promise<number[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const numbers: number[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const match = pattern.exec(entry.name);
    if (match?.[1]) numbers.push(Number.parseInt(match[1], 10));
  }

  return numbers.sort((left, right) => right - left);
}

export interface FindLatestIterationDirParams {
  evalsRootDir: string;
  skillName: string;
}

/** The newest iteration that finished, i.e. has a benchmark.json. */
export async function findLatestIterationDir({
  evalsRootDir,
  skillName,
}: FindLatestIterationDirParams): Promise<string> {
  const skillEvalsDir = join(evalsRootDir, skillName);
  if (!(await isDirectory(skillEvalsDir))) {
    throw new EvalError(`No evaluation iterations found for "${skillName}"`);
  }

  const numbers = await iterationNumbers({
    dir: skillEvalsDir,
    prefix: 'iteration',
  });

  for (const num of numbers) {
    const iterationDir = join(skillEvalsDir, `iteration-${num}`);
    const benchmark = await statIfExists(join(iterationDir, 'benchmark.json'));
    if (benchmark?.isFile()) return iterationDir;
  }

  throw new EvalError(
    numbers.length === 0
      ? `No evaluation iterations found for "${skillName}"`
      : `No completed evaluation iterations found for "${skillName}" (${numbers.length} without benchmark.json)`,
  );
}
