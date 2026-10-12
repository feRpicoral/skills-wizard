import {
  gitEnvironment,
  type Paths,
  resolvePaths,
  resolveSearchPath,
} from './env.ts';
import { githubUrl, type SourceSettings } from './skills/sources.ts';

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  sources: SourceSettings;
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
    sources: {
      url: githubUrl,
      env: gitEnvironment(),
      now: () => new Date(),
    },
    print: (line = '') => {
      process.stdout.write(`${line}\n`);
    },
  };
}
