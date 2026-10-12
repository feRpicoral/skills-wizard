import { type Paths, resolvePaths, resolveSearchPath } from './env.ts';

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  print: (line?: string) => void;
}

interface CreateContextParams {
  repoRoot: string;
  cwd: string;
  interactive: boolean;
}

export function createContext({
  repoRoot,
  cwd,
  interactive,
}: CreateContextParams): Context {
  return {
    paths: resolvePaths(),
    repoRoot,
    cwd,
    searchPath: resolveSearchPath(),
    interactive,
    print: (line = '') => {
      process.stdout.write(`${line}\n`);
    },
  };
}
