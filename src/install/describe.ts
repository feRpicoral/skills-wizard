import { relative, sep } from 'node:path';
import { styleText } from 'node:util';

import type { ActionStatus, ManifestStatus, Plan } from './plan.ts';

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

function line(
  status: ActionStatus | ManifestStatus,
  path: string,
  label: string,
): string {
  return `${styleText(STATUS_FORMAT[status], status.padEnd(STATUS_WIDTH))}  ${path}  ${styleText('dim', label)}`;
}

export function describePlan(plan: Plan, home: string): string[] {
  const show = (path: string) =>
    plan.projectDir && path.startsWith(`${plan.projectDir}${sep}`)
      ? relative(plan.projectDir, path)
      : displayPath(path, home);

  const lines = plan.actions.map((action) => {
    const target = action.writePath ? ` -> ${show(action.writePath)}` : '';
    const reason = action.reason ? ` (${action.reason})` : '';
    return line(
      action.status,
      `${show(action.path)}${target}`,
      `${action.label}${reason}`,
    );
  });
  if (plan.manifestStatus !== 'unchanged') {
    lines.push(line(plan.manifestStatus, show(plan.manifestPath), 'manifest'));
  }
  return lines;
}

export function hasChanges(plan: Plan): boolean {
  return (
    plan.manifestStatus !== 'unchanged' ||
    plan.actions.some((action) => action.change.type !== 'none')
  );
}

export function conflicts(plan: Plan) {
  return plan.actions.filter((action) => action.status === 'conflict');
}
