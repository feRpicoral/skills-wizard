import { ManagedRegionError } from '../errors.ts';
import { joinLines, type Line, lineEnding, splitLines } from './lines.ts';

interface Markers {
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

function locate(lines: readonly Line[], markers: Markers): Bounds | null {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.text.trim();
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

function regionText(body: string, markers: Markers, eol: string): string {
  return [
    markers.begin,
    ...body.replace(/\n+$/, '').split(/\r?\n/),
    markers.end,
  ].join(eol);
}

export function upsertRegion(
  existing: string | null,
  body: string,
  options: { markers?: Markers; preamble?: string } = {},
): string {
  const markers = options.markers ?? MARKDOWN_MARKERS;
  const eol = lineEnding(existing);
  const region = regionText(body, markers, eol);

  if (existing === null || existing.trim() === '') {
    const preamble = options.preamble ? `${options.preamble}${eol}${eol}` : '';
    return `${preamble}${region}${eol}`;
  }

  const lines = splitLines(existing);
  const bounds = locate(lines, markers);
  if (!bounds) return `${existing.trimEnd()}${eol}${eol}${region}${eol}`;

  return [
    joinLines(lines.slice(0, bounds.begin)),
    region,
    lines[bounds.end]?.eol ?? '',
    joinLines(lines.slice(bounds.end + 1)),
  ].join('');
}

export function removeRegion(
  existing: string,
  markers: Markers = MARKDOWN_MARKERS,
): string {
  const lines = splitLines(existing);
  const bounds = locate(lines, markers);
  if (!bounds) return existing;

  const before = lines.slice(0, bounds.begin);
  const after = lines.slice(bounds.end + 1);
  if (before.length > 0 && before.at(-1)?.text.trim() === '') {
    before.pop();
  } else if (before.length === 0 && after[0]?.text.trim() === '') {
    after.shift();
  }

  const remaining = joinLines([...before, ...after]);
  return remaining.trim() === '' ? '' : remaining;
}
