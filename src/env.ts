import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { EnvironmentError } from './errors.ts';

export interface Paths {
  home: string;
  stateDir: string;
  evalsDir: string;
  skillsDir: string;
  sourcesDir: string;
  claudeHome: string;
  codexHome: string;
  geminiHome: string;
  copilotHome: string;
  localBin: string;
}

export interface AgyConfig {
  bin?: string;
  extraArgs: string[];
}

export type Environment = Readonly<Record<string, string | undefined>>;

function directory(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) {
    throw new EnvironmentError(
      `${name} must be an absolute path, got "${value}"`,
    );
  }
  return value;
}

export function resolvePaths(env: Environment = process.env): Paths {
  const home = directory(env, 'HOME') ?? homedir();
  const cache = directory(env, 'XDG_CACHE_HOME') ?? join(home, '.cache');
  const stateDir = join(home, '.agents', 'agents-config');

  return {
    home,
    stateDir,
    evalsDir: join(stateDir, 'evals'),
    skillsDir: join(home, '.agents', 'skills'),
    sourcesDir: join(cache, 'agents-config', 'sources'),
    claudeHome: directory(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude'),
    codexHome: directory(env, 'CODEX_HOME') ?? join(home, '.codex'),
    geminiHome: join(home, '.gemini'),
    copilotHome: directory(env, 'COPILOT_HOME') ?? join(home, '.copilot'),
    localBin: join(home, '.local', 'bin'),
  };
}

// AGY_BIN must be absolute so the eval runner never depends on the PATH or
// the working directory of each isolated eval workspace.
export function resolveAgyBin(
  env: Environment = process.env,
): string | undefined {
  const value = env.AGY_BIN?.trim();
  if (!value) return undefined;
  if (!isAbsolute(value)) {
    throw new EnvironmentError(
      `AGY_BIN must be an absolute path, got "${value}"`,
    );
  }
  return value;
}

export function resolveAgyExtraArgs(env: Environment = process.env): string[] {
  const rawExtra = env.AGY_EXTRA_ARGS?.trim();
  if (!rawExtra) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawExtra);
  } catch (error) {
    throw new EnvironmentError(
      'AGY_EXTRA_ARGS must be a JSON array of strings',
      { cause: error },
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item): item is string => typeof item === 'string')
  ) {
    throw new EnvironmentError(
      'AGY_EXTRA_ARGS must be a JSON array of strings',
    );
  }
  return parsed;
}

export function resolveAgyConfig(env: Environment = process.env): AgyConfig {
  const bin = resolveAgyBin(env);
  return { ...(bin ? { bin } : {}), extraArgs: resolveAgyExtraArgs(env) };
}

export function resolveSearchPath(env: Environment = process.env): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

// What `git rev-parse --local-env-vars` lists, which git itself clears before
// it works in another repository, plus GIT_NAMESPACE. User-level settings
// such as GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM are kept.
const REPOSITORY_GIT_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);
const REPOSITORY_GIT_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

function isRepositoryGitVariable(name: string): boolean {
  return (
    REPOSITORY_GIT_VARIABLES.has(name) || REPOSITORY_GIT_PATTERN.test(name)
  );
}

export function gitEnvironment(env: Environment = process.env): Environment {
  const kept = Object.entries(env).filter(
    ([name]) => !isRepositoryGitVariable(name),
  );
  return { ...Object.fromEntries(kept), GIT_TERMINAL_PROMPT: '0' };
}
