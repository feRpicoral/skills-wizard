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
  paths?: Paths;
  searchPath?: string[];
  print?: (line?: string) => void;
}

export function createContext({
  repoRoot,
  cwd,
  interactive,
  paths = resolvePaths(),
  searchPath = resolveSearchPath(),
  print = (line = '') => {
    process.stdout.write(`${line}\n`);
  },
}: CreateContextParams): Context {
  return {
    paths,
    repoRoot,
    cwd,
    searchPath,
    interactive,
    print,
  };
}
