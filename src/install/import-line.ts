import { basename, dirname, resolve } from 'node:path';

import { readSymlink } from './fs.ts';
import {
  isBlank,
  joinLines,
  keepBom,
  type Line,
  lineEnding,
  splitLines,
} from './lines.ts';
import {
  type FileActionParams,
  NONE,
  type PlanFileParams,
  type PlannedAction,
  resolveTargetFile,
  writeAction,
} from './safety.ts';
import type { LineTarget } from './targets.ts';

function lineIndex(lines: readonly Line[], line: string): number {
  return lines.findIndex((candidate) => candidate.text.trimEnd() === line);
}

interface HasLineParams {
  content: string;
  line: string;
}

export function hasLine({ content, line }: HasLineParams): boolean {
  return lineIndex(splitLines(content), line) !== -1;
}

interface EnsureLineParams {
  existing: string | null;
  line: string;
}

export function ensureLine({ existing, line }: EnsureLineParams): string {
  if (existing === null || isBlank(existing)) return `${line}\n`;
  if (hasLine({ content: existing, line })) return existing;

  const eol = lineEnding(existing);
  return keepBom(existing, (text) => `${line}${eol}${eol}${text}`);
}

interface RemoveLineParams {
  existing: string;
  line: string;
}

export function removeLine({ existing, line }: RemoveLineParams): string {
  return keepBom(existing, (text) => removeLineFrom({ existing: text, line }));
}

function removeLineFrom({ existing, line }: RemoveLineParams): string {
  const lines = splitLines(existing);
  const index = lineIndex(lines, line);
  if (index === -1) return existing;

  const removeCount = lines[index + 1]?.text.trim() === '' ? 2 : 1;
  lines.splice(index, removeCount);
  const remaining = joinLines(lines);

  return remaining.trim() === '' ? '' : remaining;
}

export function planLine({
  target,
  file,
  previous,
}: FileActionParams<LineTarget>): PlannedAction {
  const hadLine =
    file.existing !== null &&
    hasLine({ content: file.existing, line: target.line });
  const added = hadLine ? previous?.kind === 'line' && previous.added : true;

  return writeAction({
    target,
    file,
    next: ensureLine({ existing: file.existing, line: target.line }),
    entry: {
      kind: 'line',
      path: target.path,
      line: target.line,
      added,
      createdFile: file.createdFile,
    },
    previous,
  });
}

export interface PlanSatisfiedLineParams extends PlanFileParams {
  target: LineTarget;
  satisfiedBy: string;
}

interface SameFileNoteParams {
  path: string;
  other: string;
}

async function pointsAt({ path, other }: SameFileNoteParams): Promise<boolean> {
  const link = await readSymlink(path);
  return link !== null && resolve(dirname(path), link) === other;
}

async function sameFileNote({
  path,
  other,
}: SameFileNoteParams): Promise<string> {
  const name = basename(other);

  if (await pointsAt({ path, other })) return `links to ${name}`;
  if (await pointsAt({ path: other, other: path })) return `${name} links here`;

  return `same file as ${name}`;
}

export async function planSatisfiedLine({
  target,
  previous,
  satisfiedBy,
  ...rest
}: PlanSatisfiedLineParams): Promise<PlannedAction> {
  const unchanged: PlannedAction = {
    path: target.path,
    label: `${target.label} (${await sameFileNote({ path: target.path, other: satisfiedBy })})`,
    status: 'unchanged',
    change: NONE,
    entry: null,
    previous,
  };

  if (previous?.kind !== 'line' || !previous.added) return unchanged;

  const resolved = await resolveTargetFile({ target, previous, ...rest });
  if (!resolved.ok) return resolved.action;

  const { file } = resolved;

  if (
    file.existing === null ||
    !hasLine({ content: file.existing, line: target.line })
  ) {
    return unchanged;
  }

  return {
    ...unchanged,
    ...(file.writePath !== target.path ? { writePath: file.writePath } : {}),
    status: 'update',
    change: {
      type: 'write',
      content: removeLine({ existing: file.existing, line: target.line }),
    },
    reason: 'removes an import of the file itself',
  };
}
