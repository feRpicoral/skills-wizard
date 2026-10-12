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

export function resolveAgyConfig(env: Environment = process.env): AgyConfig {
  const bin = env.AGY_BIN?.trim() || undefined;
  const rawExtra = env.AGY_EXTRA_ARGS?.trim();
  if (!rawExtra) {
    return { ...(bin ? { bin } : {}), extraArgs: [] };
  }
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
  return { ...(bin ? { bin } : {}), extraArgs: parsed };
}

export function resolveSearchPath(env: Environment = process.env): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}

export function gitEnvironment(env: Environment = process.env): Environment {
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}
