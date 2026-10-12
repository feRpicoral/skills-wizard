function lineIndex(lines: readonly string[], line: string): number {
  return lines.findIndex((candidate) => candidate.trimEnd() === line);
}

export function hasLine(content: string, line: string): boolean {
  return lineIndex(content.split('\n'), line) !== -1;
}

export function ensureLine(existing: string | null, line: string): string {
  if (existing === null || existing.trim() === '') return `${line}\n`;
  if (hasLine(existing, line)) return existing;
  return `${line}\n\n${existing}`;
}

export function removeLine(existing: string, line: string): string {
  const lines = existing.split('\n');
  const index = lineIndex(lines, line);
  if (index === -1) return existing;

  const removeCount = lines[index + 1]?.trim() === '' ? 2 : 1;
  lines.splice(index, removeCount);
  const remaining = lines.join('\n');
  return remaining.trim() === '' ? '' : remaining;
}
