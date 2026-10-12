export interface Line {
  text: string;
  eol: string;
}

export function lineEnding(content: string | null): string {
  if (!content) return '\n';
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
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
