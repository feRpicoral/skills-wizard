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
  paths?: Paths;
  searchPath?: string[];
  sources?: Partial<SourceSettings>;
  print?: (line?: string) => void;
}

export function createContext({
  repoRoot,
  cwd,
  interactive,
  paths = resolvePaths(),
  searchPath = resolveSearchPath(),
  sources,
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
    sources: {
      url: sources?.url ?? githubUrl,
      env: sources?.env ?? gitEnvironment(),
      now: sources?.now ?? (() => new Date()),
    },
    print,
  };
}
