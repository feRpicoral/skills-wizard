import {
  gitEnvironment,
  hasEnvVar,
  type Paths,
  resolveAgyBin,
  resolveAgyExtraArgs,
  resolveMcpRegistryUrl,
  resolvePaths,
  resolveSearchPath,
  resolveSkillsShUrl,
} from './env.ts';
import { githubUrl, type SourceSettings } from './skills/sources.ts';

// Read lazily: only agy evals (and runner auto-detection, for the binary)
// need these, so a malformed AGY_EXTRA_ARGS never breaks other commands and
// an invalid AGY_BIN is never read when --binary overrides it.
export interface AgySettings {
  bin: () => string | undefined;
  extraArgs: () => string[];
}

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  sources: SourceSettings;
  agy?: AgySettings;
  hasEnvVar?: (name: string) => boolean;
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
      skillsShUrl: () => resolveSkillsShUrl(),
      mcpRegistryUrl: (official) =>
        resolveMcpRegistryUrl({
          ...(official !== undefined ? { official } : {}),
        }),
    },
    agy: {
      bin: () => resolveAgyBin(),
      extraArgs: () => resolveAgyExtraArgs(),
    },
    hasEnvVar: (name) => hasEnvVar(name),
    print: (line = '') => {
      process.stdout.write(`${line}\n`);
    },
  };
}
