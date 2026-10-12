import { joinLines, type Line, lineEnding, splitLines } from './lines.ts';

function lineIndex(lines: readonly Line[], line: string): number {
  return lines.findIndex((candidate) => candidate.text.trim() === line);
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
  if (existing === null || existing.trim() === '') return `${line}\n`;
  if (hasLine({ content: existing, line })) return existing;
  const eol = lineEnding(existing);
  return `${line}${eol}${eol}${existing}`;
}

interface RemoveLineParams {
  existing: string;
  line: string;
}

export function removeLine({ existing, line }: RemoveLineParams): string {
  const lines = splitLines(existing);
  const index = lineIndex(lines, line);
  if (index === -1) return existing;

  const removeCount = lines[index + 1]?.text.trim() === '' ? 2 : 1;
  lines.splice(index, removeCount);
  const remaining = joinLines(lines);
  return remaining.trim() === '' ? '' : remaining;
}
