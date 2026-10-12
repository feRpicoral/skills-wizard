import { ManagedRegionError } from '../errors.ts';

export interface Markers {
  begin: string;
  end: string;
}

export const MARKDOWN_MARKERS: Markers = {
  begin: '<!-- BEGIN:agents-config -->',
  end: '<!-- END:agents-config -->',
};

export const HASH_MARKERS: Markers = {
  begin: '# BEGIN:agents-config',
  end: '# END:agents-config',
};

interface Bounds {
  begin: number;
  end: number;
}

function locate(lines: readonly string[], markers: Markers): Bounds | null {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trimEnd();
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

function regionText(body: string, markers: Markers): string {
  return `${markers.begin}\n${body.replace(/\n+$/, '')}\n${markers.end}`;
}

export function hasRegion(
  content: string,
  markers: Markers = MARKDOWN_MARKERS,
): boolean {
  return locate(content.split('\n'), markers) !== null;
}

export function upsertRegion(
  existing: string | null,
  body: string,
  options: { markers?: Markers; preamble?: string } = {},
): string {
  const markers = options.markers ?? MARKDOWN_MARKERS;
  const region = regionText(body, markers);

  if (existing === null || existing.trim() === '') {
    const preamble = options.preamble ? `${options.preamble}\n\n` : '';
    return `${preamble}${region}\n`;
  }

  const lines = existing.split('\n');
  const bounds = locate(lines, markers);
  if (!bounds) {
    return `${existing.trimEnd()}\n\n${region}\n`;
  }

  return [
    ...lines.slice(0, bounds.begin),
    region,
    ...lines.slice(bounds.end + 1),
  ].join('\n');
}

export function removeRegion(
  existing: string,
  markers: Markers = MARKDOWN_MARKERS,
): string {
  const lines = existing.split('\n');
  const bounds = locate(lines, markers);
  if (!bounds) return existing;

  const before = lines.slice(0, bounds.begin);
  const after = lines.slice(bounds.end + 1);
  if (before.length > 0 && before.at(-1)?.trim() === '') {
    before.pop();
  } else if (before.length === 0 && after[0]?.trim() === '') {
    after.shift();
  }

  const remaining = [...before, ...after].join('\n');
  return remaining.trim() === '' ? '' : `${remaining.trimEnd()}\n`;
}
