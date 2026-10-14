import { ManagedRegionError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import {
  isBlank,
  joinLines,
  keepBom,
  type Line,
  lineEnding,
  splitLines,
} from './lines.ts';
import {
  conflict,
  type FileActionParams,
  type PlannedAction,
  type ResolvedTargetFile,
  writeAction,
} from './safety.ts';
import type { ExcludeRegionTarget, RegionTarget } from './targets.ts';

interface Markers {
  begin: string;
  end: string;
}

export const MARKDOWN_MARKERS: Markers = {
  begin: '<!-- BEGIN:agents-config -->',
  end: '<!-- END:agents-config -->',
};

export function excludeMarkers(id: string): Markers {
  if (/[\r\n]/.test(id)) {
    throw new ManagedRegionError(
      'exclude region id must not contain line breaks',
    );
  }
  return {
    begin: `# BEGIN:agents-config ${id}`,
    end: `# END:agents-config ${id}`,
  };
}

export function gitignorePattern(path: string): string {
  if (/[\r\n]/.test(path)) {
    throw new ManagedRegionError(
      'git exclude entry path must not contain line breaks',
    );
  }
  const escaped = path
    .replace(/[[\]*?\\]/g, '\\$&')
    .replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length));
  return `/${escaped}`;
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
    ...body.replace(/(?:\r?\n)+$/, '').split(/\r?\n/),
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

interface RegionPreambleParams {
  target: RegionTarget;
  file: ResolvedTargetFile;
  previous: ManifestEntry | null;
}

function regionPreamble({
  target,
  file,
  previous,
}: RegionPreambleParams): string | undefined {
  // A file reached through a link is not the CLI's, so neither is its heading.
  if (file.writePath !== target.path) return undefined;
  const { existing } = file;
  if (existing === null || isBlank(existing)) return target.preamble;
  const preamble = previous?.kind === 'region' ? previous.preamble : undefined;
  return preamble && existing.trimStart().startsWith(preamble)
    ? preamble
    : undefined;
}

export function planRegion({
  target,
  file,
  previous,
}: FileActionParams<RegionTarget>): PlannedAction {
  try {
    // A heading is only written into a file the CLI may own, never through a
    // link, so install and removal agree on who owns it.
    const ownsHeading = file.writePath === target.path;
    const next = upsertRegion({
      existing: file.existing,
      body: target.body,
      markers: MARKDOWN_MARKERS,
      ...(target.preamble && ownsHeading ? { preamble: target.preamble } : {}),
    });
    const preamble = regionPreamble({ target, file, previous });
    const entry: ManifestEntry = {
      kind: 'region',
      path: target.path,
      createdFile: file.createdFile,
      ...(preamble ? { preamble } : {}),
    };
    return writeAction({ target, file, next, entry, previous });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}

export function planExcludeRegion({
  target,
  file,
  previous,
}: FileActionParams<ExcludeRegionTarget>): PlannedAction {
  try {
    const body = target.paths.map((path) => gitignorePattern(path)).join('\n');
    const next = upsertRegion({
      existing: file.existing,
      body,
      markers: excludeMarkers(target.id),
    });
    const entry: ManifestEntry = {
      kind: 'exclude-region',
      path: target.path,
      id: target.id,
      createdFile: file.createdFile,
    };
    return writeAction({ target, file, next, entry, previous });
  } catch (error) {
    if (error instanceof ManagedRegionError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}
