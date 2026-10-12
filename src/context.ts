import {
  type Environment,
  type Paths,
  resolvePaths,
  resolveSearchPath,
} from './env.ts';

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  now: () => Date;
  print: (line?: string) => void;
}

export function createContext(options: {
  env: Environment;
  repoRoot: string;
  cwd: string;
  interactive: boolean;
}): Context {
  return {
    paths: resolvePaths(options.env),
    repoRoot: options.repoRoot,
    cwd: options.cwd,
    searchPath: resolveSearchPath(options.env),
    interactive: options.interactive,
    now: () => new Date(),
    print: (line = '') => {
      process.stdout.write(`${line}\n`);
    },
  };
}
