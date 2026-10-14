import { delimiter } from 'node:path';

import which from 'which';

import type { Paths } from '../env.ts';
import { lstatIfExists } from '../install/fs.ts';
import { TOOL_IDS, type ToolId, TOOLS } from './registry.ts';

async function anyExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if (await lstatIfExists(path)) return true;
  }
  return false;
}

interface SearchPathCheck {
  bins: readonly string[];
  searchPath: readonly string[];
}

async function onSearchPath({
  bins,
  searchPath,
}: SearchPathCheck): Promise<boolean> {
  const path = searchPath.join(delimiter);
  if (!path) return false;
  for (const bin of bins) {
    if (await which(bin, { path, nothrow: true })) return true;
  }
  return false;
}

export async function detectTools(
  paths: Paths,
  searchPath: readonly string[],
): Promise<ToolId[]> {
  const results = await Promise.all(
    TOOL_IDS.map(async (id) => {
      const { dirs, bins } = TOOLS[id].detect;
      const installed =
        (await anyExists(dirs(paths))) ||
        (await onSearchPath({ bins, searchPath }));
      return installed ? id : null;
    }),
  );
  return results.filter((id): id is ToolId => id !== null);
}
