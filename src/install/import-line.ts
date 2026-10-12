import { lineEnding } from './managed-region.ts';

function lineIndex(lines: readonly string[], line: string): number {
  return lines.findIndex((candidate) => candidate.trim() === line);
}

export function hasLine(content: string, line: string): boolean {
  return lineIndex(content.split(/\r?\n/), line) !== -1;
}

export function ensureLine(existing: string | null, line: string): string {
  if (existing === null || existing.trim() === '') return `${line}\n`;
  if (hasLine(existing, line)) return existing;
  const eol = lineEnding(existing);
  return `${line}${eol}${eol}${existing}`;
}

export function removeLine(existing: string, line: string): string {
  const eol = lineEnding(existing);
  const lines = existing.split(/\r?\n/);
  const index = lineIndex(lines, line);
  if (index === -1) return existing;

  const removeCount = lines[index + 1]?.trim() === '' ? 2 : 1;
  lines.splice(index, removeCount);
  const remaining = lines.join(eol);
  return remaining.trim() === '' ? '' : remaining;
}
