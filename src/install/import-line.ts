import { joinLines, type Line, lineEnding, splitLines } from './lines.ts';

function lineIndex(lines: readonly Line[], line: string): number {
  return lines.findIndex((candidate) => candidate.text.trim() === line);
}

export function hasLine(content: string, line: string): boolean {
  return lineIndex(splitLines(content), line) !== -1;
}

export function ensureLine(existing: string | null, line: string): string {
  if (existing === null || existing.trim() === '') return `${line}\n`;
  if (hasLine(existing, line)) return existing;
  const eol = lineEnding(existing);
  return `${line}${eol}${eol}${existing}`;
}

export function removeLine(existing: string, line: string): string {
  const lines = splitLines(existing);
  const index = lineIndex(lines, line);
  if (index === -1) return existing;

  const removeCount = lines[index + 1]?.text.trim() === '' ? 2 : 1;
  lines.splice(index, removeCount);
  const remaining = joinLines(lines);
  return remaining.trim() === '' ? '' : remaining;
}
