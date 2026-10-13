import { ManagedRegionError } from '../errors.ts';
import {
  isBlank,
  joinLines,
  keepBom,
  type Line,
  lineEnding,
  splitLines,
} from './lines.ts';

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
    // Markers are compared trimmed on both sides, so an id that ends in
    // whitespace (a directory such as `app `) still finds its own region.
    const trimmed = line.text.trim();
    if (trimmed === markers.begin.trim()) begins.push(index);
    if (trimmed === markers.end.trim()) ends.push(index);
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

interface RegionTextParams {
  body: string;
  markers: Markers;
  eol: string;
}

function regionText({ body, markers, eol }: RegionTextParams): string {
  return [
    markers.begin,
    ...body.replace(/\n+$/, '').split(/\r?\n/),
    markers.end,
  ].join(eol);
}

interface UpsertRegionParams {
  existing: string | null;
  body: string;
  markers?: Markers;
  preamble?: string;
}

export function upsertRegion({
  existing,
  ...rest
}: UpsertRegionParams): string {
  if (existing === null) return upsertText({ existing, ...rest });
  return keepBom(existing, (text) => upsertText({ existing: text, ...rest }));
}

function upsertText({
  existing,
  body,
  markers = MARKDOWN_MARKERS,
  preamble,
}: UpsertRegionParams): string {
  const eol = lineEnding(existing);
  const region = regionText({ body, markers, eol });

  if (existing === null || isBlank(existing)) {
    const prefix = preamble ? `${preamble}${eol}${eol}` : '';
    return `${prefix}${region}${eol}`;
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
  return keepBom(existing, (text) => removeText(text, markers));
}

function removeText(existing: string, markers: Markers): string {
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
