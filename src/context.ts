import {
  gitEnvironment,
  type Paths,
  resolveAgyBin,
  resolveAgyExtraArgs,
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

export interface DiscoverySettings {
  skillsShUrl?: string | (() => string);
  fetch?: typeof globalThis.fetch;
}

export interface Context {
  paths: Paths;
  repoRoot: string;
  cwd: string;
  searchPath: string[];
  interactive: boolean;
  sources: SourceSettings;
  discovery?: DiscoverySettings;
  agy?: AgySettings;
  print: (line?: string) => void;
}

interface CreateContextParams {
  repoRoot: string;
  cwd: string;
  interactive: boolean;
  paths?: Paths;
  searchPath?: string[];
  sources?: Partial<SourceSettings>;
  discovery?: Partial<DiscoverySettings>;
  print?: (line?: string) => void;
}

export function createContext({
  repoRoot,
  cwd,
  interactive,
  paths = resolvePaths(),
  searchPath = resolveSearchPath(),
  sources,
  discovery,
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
    discovery: {
      skillsShUrl: discovery?.skillsShUrl ?? (() => resolveSkillsShUrl()),
      ...(discovery?.fetch !== undefined ? { fetch: discovery.fetch } : {}),
    },
    agy: {
      bin: () => resolveAgyBin(),
      extraArgs: () => resolveAgyExtraArgs(),
    },
    print,
  };
}
