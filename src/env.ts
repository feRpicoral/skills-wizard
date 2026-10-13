import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { EnvironmentError } from './errors.ts';

export interface Paths {
  home: string;
  stateDir: string;
  skillsDir: string;
  sourcesDir: string;
  claudeHome: string;
  codexHome: string;
  geminiHome: string;
  copilotHome: string;
  localBin: string;
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

  return {
    home,
    stateDir: join(home, '.agents', 'agents-config'),
    skillsDir: join(home, '.agents', 'skills'),
    sourcesDir: join(cache, 'agents-config', 'sources'),
    claudeHome: directory(env, 'CLAUDE_CONFIG_DIR') ?? join(home, '.claude'),
    codexHome: directory(env, 'CODEX_HOME') ?? join(home, '.codex'),
    geminiHome: join(home, '.gemini'),
    copilotHome: directory(env, 'COPILOT_HOME') ?? join(home, '.copilot'),
    localBin: join(home, '.local', 'bin'),
  };
}

export function resolveSearchPath(env: Environment = process.env): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

const REPOSITORY_GIT_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

export function gitEnvironment(env: Environment = process.env): Environment {
  const kept = Object.entries(env).filter(
    ([name]) => !REPOSITORY_GIT_VARIABLES.has(name),
  );
  return { ...Object.fromEntries(kept), GIT_TERMINAL_PROMPT: '0' };
}
