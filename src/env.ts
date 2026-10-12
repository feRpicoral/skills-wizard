import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface Paths {
  home: string;
  agentsHome: string;
  stateDir: string;
  claudeHome: string;
  codexHome: string;
  geminiHome: string;
  copilotHome: string;
  xdgConfigHome: string;
  xdgCacheHome: string;
  localBin: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export function resolvePaths(env: Environment = process.env): Paths {
  const home = env.HOME ?? homedir();
  const agentsHome = join(home, '.agents');

  return {
    home,
    agentsHome,
    stateDir: join(agentsHome, 'agents-config'),
    claudeHome: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    codexHome: env.CODEX_HOME ?? join(home, '.codex'),
    geminiHome: join(home, '.gemini'),
    copilotHome: env.COPILOT_HOME ?? join(home, '.copilot'),
    xdgConfigHome: env.XDG_CONFIG_HOME ?? join(home, '.config'),
    xdgCacheHome: env.XDG_CACHE_HOME ?? join(home, '.cache'),
    localBin: join(home, '.local', 'bin'),
  };
}

export function resolveSearchPath(env: Environment = process.env): string[] {
  return (env.PATH ?? '').split(delimiter).filter(Boolean);
}
