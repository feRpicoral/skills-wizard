import * as clack from '@clack/prompts';

import type { Context } from '../context.ts';
import { displayPath } from '../install/describe.ts';
import type { Location } from './location.ts';

export interface NotifyParams {
  ctx: Context;
  prompting: boolean;
  message: string;
  level?: 'info' | 'warn';
}

export function notify({
  ctx,
  prompting,
  message,
  level = 'info',
}: NotifyParams): void {
  if (!prompting) {
    ctx.print(message);
  } else if (level === 'warn') {
    clack.log.warn(message);
  } else {
    clack.log.info(message);
  }
}

export interface NotifyLeftGitParams {
  ctx: Context;
  prompting: boolean;
  projectDir: string;
}

export function notifyLeftGit({
  ctx,
  prompting,
  projectDir,
}: NotifyLeftGitParams): void {
  notify({
    ctx,
    prompting,
    message: `${displayPath({ path: projectDir, home: ctx.paths.home })} is no longer in a git repository, so its files are no longer kept local.`,
    level: 'warn',
  });
}

export interface SetVariablesCommandParams {
  ctx: Context;
  location: Location;
  names: readonly string[];
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

// A leading ~ stays unquoted so the shell still expands it.
function shellPath(path: string): string {
  if (path === '~') return path;

  return path.startsWith('~/')
    ? `~/${shellQuote(path.slice(2))}`
    : shellQuote(path);
}

export function setVariablesCommand({
  ctx,
  location,
  names,
}: SetVariablesCommandParams): string {
  const target = location.project
    ? `--project ${shellPath(displayPath({ path: location.project.dir, home: ctx.paths.home }))}`
    : '--global';
  const variables = names.map((name) => `--var ${name}=<value>`).join(' ');
  return `skills-wizard init ${target} ${variables}`;
}
