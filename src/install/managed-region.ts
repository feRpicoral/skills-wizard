import { ManagedRegionError } from '../errors.ts';

export interface Markers {
  begin: string;
  end: string;
}

export const MARKDOWN_MARKERS: Markers = {
  begin: '<!-- BEGIN:agents-config -->',
  end: '<!-- END:agents-config -->',
};

export function excludeMarkers(id: string): Markers {
  return {
    begin: `# BEGIN:agents-config ${id}`,
    end: `# END:agents-config ${id}`,
  };
}

interface Bounds {
  begin: number;
  end: number;
}

export function lineEnding(content: string | null): string {
  return content?.includes('\r\n') ? '\r\n' : '\n';
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function locate(lines: readonly string[], markers: Markers): Bounds | null {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === markers.begin) begins.push(index);
    if (trimmed === markers.end) ends.push(index);
  });

  if (begins.length === 0 && ends.length === 0) return null;
  if (begins.length !== 1 || ends.length !== 1) {
    throw new ManagedRegionError(
      `expected one managed region, found ${begins.length} begin and ${ends.length} end markers`,
    );
  }
  const [begin] = begins as [number];
  const [end] = ends as [number];
  if (begin > end) {
    throw new ManagedRegionError('end marker appears before begin marker');
  }
  return { begin, end };
}

function regionLines(body: string, markers: Markers): string[] {
  return [markers.begin, ...splitLines(body.replace(/\n+$/, '')), markers.end];
}

export function upsertRegion(
  existing: string | null,
  body: string,
  options: { markers?: Markers; preamble?: string } = {},
): string {
  const markers = options.markers ?? MARKDOWN_MARKERS;
  const eol = lineEnding(existing);
  const region = regionLines(body, markers);

  if (existing === null || existing.trim() === '') {
    const preamble = options.preamble ? [options.preamble, ''] : [];
    return [...preamble, ...region, ''].join(eol);
  }

  const lines = splitLines(existing);
  const bounds = locate(lines, markers);
  if (!bounds) {
    return [...splitLines(existing.trimEnd()), '', ...region, ''].join(eol);
  }

  return [
    ...lines.slice(0, bounds.begin),
    ...region,
    ...lines.slice(bounds.end + 1),
  ].join(eol);
}

export function removeRegion(
  existing: string,
  markers: Markers = MARKDOWN_MARKERS,
): string {
  const eol = lineEnding(existing);
  const lines = splitLines(existing);
  const bounds = locate(lines, markers);
  if (!bounds) return existing;

  const before = lines.slice(0, bounds.begin);
  const after = lines.slice(bounds.end + 1);
  if (before.length > 0 && before.at(-1)?.trim() === '') {
    before.pop();
  } else if (before.length === 0 && after[0]?.trim() === '') {
    after.shift();
  }

  const remaining = [...before, ...after].join(eol);
  return remaining.trim() === '' ? '' : `${remaining.trimEnd()}${eol}`;
}
