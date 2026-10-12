import { type Paths, resolvePaths, resolveSearchPath } from './env.ts';

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  print: (line?: string) => void;
}

export function createContext(options: {
  repoRoot: string;
  cwd: string;
  interactive: boolean;
}): Context {
  return {
    paths: resolvePaths(),
    repoRoot: options.repoRoot,
    cwd: options.cwd,
    searchPath: resolveSearchPath(),
    interactive: options.interactive,
    print: (line = '') => {
      process.stdout.write(`${line}\n`);
    },
  };
}
