import {
  type AgyConfig,
  gitEnvironment,
  type Paths,
  resolveAgyBin,
  resolveAgyConfig,
  resolvePaths,
  resolveSearchPath,
} from './env.ts';
import { githubUrl, type SourceSettings } from './skills/sources.ts';

// Read lazily: only agy evals (and runner auto-detection, for the binary)
// need these, so a malformed AGY_EXTRA_ARGS never breaks other commands.
export interface AgySettings {
  bin: () => string | undefined;
  config: () => AgyConfig;
}

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  sources: SourceSettings;
  agy?: AgySettings;
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
    agy: {
      bin: () => resolveAgyBin(),
      config: () => resolveAgyConfig(),
    },
    print: (line = '') => {
      process.stdout.write(`${line}\n`);
    },
  };
}
