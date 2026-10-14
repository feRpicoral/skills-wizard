import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import { type Context, createContext } from '../context.ts';
import type { Paths } from '../env.ts';
import { tempPaths, tempSearchPath } from './fixtures.ts';
import { isolatedGitEnv } from './git.ts';

export const run = promisify(execFile);
export const REPO_ROOT = join(import.meta.dirname, '..', '..');

export interface CommandSandbox {
  paths: Paths;
  home: string;
  createCtx: (options?: { extraPath?: string }) => {
    ctx: Context;
    output: () => string;
  };
}

export async function commandSandbox(t: TestContext): Promise<CommandSandbox> {
  const paths = await tempPaths(t);
  const baseSearchPath = (await tempSearchPath(t, ['node', 'git']))
    .split(delimiter)
    .filter(Boolean);
  return {
    paths,
    home: paths.home,
    createCtx: ({ extraPath } = {}) => {
      const lines: string[] = [];
      const searchPath = extraPath
        ? [extraPath, ...baseSearchPath]
        : baseSearchPath;
      const ctx = createContext({
        repoRoot: REPO_ROOT,
        cwd: paths.home,
        interactive: false,
        paths,
        searchPath,
        sources: {
          url: () => 'file:///nowhere.git',
          env: isolatedGitEnv(paths.home),
        },
        print: (line = '') => {
          lines.push(line);
        },
      });
      return {
        ctx,
        output: () => `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`,
      };
    },
  };
}

export function manifestPath(home: string): string {
  return join(home, '.agents', 'agents-config', 'manifest.json');
}

export function projectManifestPath(project: string): string {
  return join(project, '.agents', 'agents-config.json');
}

export interface RecordedBlockParams {
  file: string;
  id: string;
}

export async function addRecordedBlock({
  file,
  id,
}: RecordedBlockParams): Promise<void> {
  const manifest = JSON.parse(await readFile(file, 'utf8')) as {
    blocks: string[];
  };
  manifest.blocks.push(id);
  await writeFile(file, JSON.stringify(manifest));
}

export async function clearRecordedVariables(file: string): Promise<void> {
  const manifest = JSON.parse(await readFile(file, 'utf8')) as {
    variables: Record<string, string>;
  };
  manifest.variables = {};
  await writeFile(file, JSON.stringify(manifest));
}
