import {
  isBlank,
  joinLines,
  keepBom,
  type Line,
  lineEnding,
  splitLines,
} from './lines.ts';

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
