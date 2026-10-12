import { relative, sep } from 'node:path';
import { styleText } from 'node:util';

import type { ActionStatus, Plan } from './plan.ts';

type Format = Parameters<typeof styleText>[0];

const STATUS_FORMAT: Record<ActionStatus, Format> = {
  create: 'green',
  update: 'yellow',
  remove: 'red',
  unchanged: 'dim',
  conflict: ['red', 'bold'],
};

const STATUS_WIDTH = Math.max(
  ...Object.keys(STATUS_FORMAT).map((status) => status.length),
);

export function displayPath(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`)
    ? `~${path.slice(home.length)}`
    : path;
}

export function describePlan(
  plan: Plan,
  home: string,
  baseDir?: string,
): string[] {
  const show = (path: string) =>
    baseDir && path.startsWith(`${baseDir}${sep}`)
      ? relative(baseDir, path)
      : displayPath(path, home);
  return plan.actions.map((action) => {
    const status = styleText(
      STATUS_FORMAT[action.status],
      action.status.padEnd(STATUS_WIDTH),
    );
    const reason = action.reason ? ` (${action.reason})` : '';
    return `${status}  ${show(action.path)}  ${styleText('dim', action.label)}${reason}`;
  });
}

export function hasChanges(plan: Plan): boolean {
  return plan.actions.some((action) => action.change.type !== 'none');
}

export function conflicts(plan: Plan) {
  return plan.actions.filter((action) => action.status === 'conflict');
}
