import { detectNewlineGraceful } from 'detect-newline';

export interface Line {
  text: string;
  eol: string;
}

const BOM = '\uFEFF';

export function keepBom(
  content: string,
  edit: (text: string) => string,
): string {
  const bom = content.startsWith(BOM) ? BOM : '';
  const next = edit(content.slice(bom.length));
  return next === '' ? '' : `${bom}${next}`;
}

export function isBlank(content: string | null): boolean {
  return content === null || content.trim() === '';
}

export function lineEnding(content: string | null): string {
  return content ? detectNewlineGraceful(content) : '\n';
}

export function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const match of content.matchAll(/\r?\n/g)) {
    lines.push({ text: content.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: content.slice(start), eol: '' });
  return lines;
}

export function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => `${line.text}${line.eol}`).join('');
}
