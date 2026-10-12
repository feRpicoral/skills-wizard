import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import type { Paths } from '../env.ts';
import { lstatIfExists } from '../install/fs.ts';
import { TOOL_IDS, type ToolId, TOOLS } from './registry.ts';

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if (await lstatIfExists(path)) return true;
  }
  return false;
}

async function onSearchPath(
  bins: readonly string[],
  searchPath: readonly string[],
): Promise<boolean> {
  for (const bin of bins) {
    for (const dir of searchPath) {
      if (await isExecutable(join(dir, bin))) return true;
    }
  }
  return false;
}

export async function detectTools(
  paths: Paths,
  searchPath: readonly string[],
): Promise<ToolId[]> {
  const detected: ToolId[] = [];
  for (const id of TOOL_IDS) {
    const { dirs, bins } = TOOLS[id].detect;
    if (
      (await anyExists(dirs(paths))) ||
      (await onSearchPath(bins, searchPath))
    ) {
      detected.push(id);
    }
  }
  return detected;
}
