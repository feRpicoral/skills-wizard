import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

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
  applicationsDir: string;
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

  return resolve(value);
}

export function resolvePaths(env: Environment = process.env): Paths {
  const home = directory(env, 'HOME') ?? homedir();
  const cache = directory(env, 'XDG_CACHE_HOME') ?? join(home, '.cache');
  const stateDir = join(home, '.agents', 'skills-wizard');

  return {
    home,
    stateDir,
    evalsDir: join(stateDir, 'evals'),
    skillsDir: join(home, '.agents', 'skills'),
    sourcesDir: join(cache, 'skills-wizard', 'sources'),
    claudeHome: directory(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude'),
    codexHome: directory(env, 'CODEX_HOME') ?? join(home, '.codex'),
    geminiHome: join(home, '.gemini'),
    copilotHome: directory(env, 'COPILOT_HOME') ?? join(home, '.copilot'),
    localBin: join(home, '.local', 'bin'),
    applicationsDir: '/Applications',
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

const stringArraySchema = z.array(z.string());

export function resolveAgyExtraArgs(env: Environment = process.env): string[] {
  const rawExtra = env.AGY_EXTRA_ARGS?.trim();
  if (!rawExtra) return [];

  try {
    return stringArraySchema.parse(JSON.parse(rawExtra));
  } catch (error) {
    throw new EnvironmentError(
      'AGY_EXTRA_ARGS must be a JSON array of strings',
      { cause: error },
    );
  }
}

export function resolveAgyConfig(env: Environment = process.env): AgyConfig {
  const bin = resolveAgyBin(env);

  return { ...(bin ? { bin } : {}), extraArgs: resolveAgyExtraArgs(env) };
}

export function resolveSearchPath(env: Environment = process.env): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

export const DEFAULT_SKILLS_SH_URL = 'https://skills.sh';

export function resolveSkillsShUrl(env: Environment = process.env): string {
  const value = env.SKILLS_SH_URL?.trim();
  if (!value) return DEFAULT_SKILLS_SH_URL;

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch (error) {
    throw new EnvironmentError(
      `SKILLS_SH_URL must be an http:// or https:// URL, got "${value}"`,
      { cause: error },
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvironmentError(
      `SKILLS_SH_URL must be an http:// or https:// URL, got "${value}"`,
    );
  }

  if (
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new EnvironmentError(
      `SKILLS_SH_URL must not include credentials, query parameters, or fragments, got "${value}"`,
    );
  }

  return value.replace(/\/+$/, '');
}

export const DEFAULT_GITHUB_MCP_REGISTRY_URL =
  'https://api.mcp.github.com/v0.1/servers';
export const DEFAULT_OFFICIAL_MCP_REGISTRY_URL =
  'https://registry.modelcontextprotocol.io/v0.1/servers';

export interface ResolveMcpRegistryUrlParams {
  official?: boolean;
  env?: Environment;
}

export function resolveMcpRegistryUrl({
  official = false,
  env = process.env,
}: ResolveMcpRegistryUrlParams = {}): string {
  const value = env.MCP_REGISTRY_URL?.trim();
  if (!value) {
    return official
      ? DEFAULT_OFFICIAL_MCP_REGISTRY_URL
      : DEFAULT_GITHUB_MCP_REGISTRY_URL;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch (error) {
    throw new EnvironmentError(
      `MCP_REGISTRY_URL must be an http:// or https:// URL, got "${value}"`,
      { cause: error },
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EnvironmentError(
      `MCP_REGISTRY_URL must be an http:// or https:// URL, got "${value}"`,
    );
  }

  if (
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new EnvironmentError(
      `MCP_REGISTRY_URL must not include credentials, query parameters, or fragments, got "${value}"`,
    );
  }

  return value.replace(/\/+$/, '');
}

export function hasEnvVar(
  name: string,
  env: Environment = process.env,
): boolean {
  return Boolean(env[name]?.trim());
}

// What `git rev-parse --local-env-vars` lists, plus GIT_NAMESPACE and the
// GIT_CONFIG_KEY_n/VALUE_n pairs. This also drops `-c` settings a caller
// passed (GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT); put settings the cache
// needs, such as proxies or extra headers, in the global git config instead.
// User-level settings such as GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM are
// kept.
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
