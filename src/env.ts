import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { EnvironmentError } from './errors.ts';

export interface Paths {
  home: string;
  stateDir: string;
  claudeHome: string;
  codexHome: string;
  geminiHome: string;
  copilotHome: string;
  localBin: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

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

  return {
    home,
    stateDir: join(home, '.agents', 'agents-config'),
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
