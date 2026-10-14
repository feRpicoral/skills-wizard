import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Byte budgets keep the grader prompt under PROMPT_BUDGET_BYTES.
export const PROMPT_BUDGET_BYTES = 100_000;
export const WORKSPACE_SUMMARY_BUDGET = 60_000;
export const RESPONSE_BUDGET_BYTES = 24_000;
export const FILE_PREVIEW_BYTES = 8_000;
export const LISTING_BUDGET_BYTES = 6_000;

export const WORKSPACE_SKIP_DIRS = new Set([
  '.git',
  '.agents',
  '.claude',
  '.gemini',
  '.codex',
  '.cache',
  '.gradle',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.pytest_cache',
  '.tox',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

interface WorkspaceFile {
  relPath: string;
  fullPath: string;
  size: number;
}

interface WorkspaceListing {
  files: WorkspaceFile[];
  /** Paths that could not be read, with the reason. */
  unreadable: string[];
}

interface CollectWorkspaceFilesParams {
  workdir: string;
  segments?: readonly string[];
  listing?: WorkspaceListing;
}

function errorCode(error: unknown): string {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.message
      : String(error);
}

// Folders or files the agent made unreadable are listed, not fatal.
async function collectWorkspaceFiles({
  workdir,
  segments = [],
  listing = { files: [], unreadable: [] },
}: CollectWorkspaceFilesParams): Promise<WorkspaceListing> {
  let entries;
  try {
    entries = await readdir(join(workdir, ...segments), {
      withFileTypes: true,
    });
  } catch (error) {
    listing.unreadable.push(
      `${segments.length > 0 ? `${segments.join('/')}/` : './'} (${errorCode(error)})`,
    );
    return listing;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    const relSegments = [...segments, entry.name];
    if (entry.isDirectory()) {
      await collectWorkspaceFiles({ workdir, segments: relSegments, listing });
    } else if (entry.isFile()) {
      const fullPath = join(workdir, ...relSegments);
      const relPath = relSegments.join('/');
      try {
        const info = await stat(fullPath);
        listing.files.push({ relPath, fullPath, size: info.size });
      } catch (error) {
        listing.unreadable.push(`${relPath} (${errorCode(error)})`);
      }
    }
  }
  return listing;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * Returns the longest valid UTF-8 prefix of `buffer` within `maxBytes` that
 * ends on a complete code point (trailing incomplete multi-byte sequences are
 * buffered by `StringDecoder.write` and omitted rather than replaced with
 * U+FFFD).
 */
export function utf8Head(buffer: Buffer, maxBytes: number): string {
  const end = Math.max(0, Math.min(maxBytes, buffer.length));
  return new StringDecoder('utf8').write(buffer.subarray(0, end));
}

/**
 * Returns the longest valid UTF-8 suffix of `buffer` within `maxBytes` that
 * starts on a character boundary.
 */
export function utf8Tail(buffer: Buffer, maxBytes: number): string {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length && isContinuationByte(buffer[start])) start += 1;
  return new StringDecoder('utf8').write(buffer.subarray(start));
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

interface ListingSectionParams {
  title: string;
  lines: readonly string[];
}

function listingSection({ title, lines }: ListingSectionParams): string {
  const kept: string[] = [];
  let used = byteLength(title);
  for (const line of lines) {
    used += byteLength(line) + 1;
    if (used > LISTING_BUDGET_BYTES) break;
    kept.push(line);
  }
  const more = lines.length - kept.length;
  return [title, ...kept, ...(more > 0 ? [`... and ${more} more`] : [])].join(
    '\n',
  );
}

export interface SummarizeWorkspaceParams {
  workdir: string;
  /** UTF-8 bytes of file content and headers to include. */
  budget?: number;
}

/**
 * Renders workspace files for the blind grader: text files only, each capped,
 * the whole summary capped (in UTF-8 bytes), build and vendor folders skipped.
 * Files that were cut short, left out or unreadable are listed by path at the
 * end.
 */
export async function summarizeWorkspace({
  workdir,
  budget = WORKSPACE_SUMMARY_BUDGET,
}: SummarizeWorkspaceParams): Promise<string[]> {
  const { files, unreadable } = await collectWorkspaceFiles({ workdir });
  const sections: string[] = [];
  const shortened: string[] = [];
  let remaining = budget;

  for (const file of files) {
    if (remaining <= 0) {
      shortened.push(`${file.relPath} (${file.size} bytes, omitted)`);
      continue;
    }
    let head: Buffer;
    try {
      head = await readHead(
        file.fullPath,
        Math.min(file.size, FILE_PREVIEW_BYTES + 1),
      );
    } catch (error) {
      unreadable.push(`${file.relPath} (${errorCode(error)})`);
      continue;
    }
    if (head.includes(0)) {
      const line = `--- ${file.relPath} (binary, ${file.size} bytes) ---`;
      sections.push(line);
      // Sections are joined with a blank line.
      remaining -= byteLength(line) + 2;
      continue;
    }
    const preview = utf8Head(head, Math.min(FILE_PREVIEW_BYTES, remaining));
    const truncated = file.size > byteLength(preview);
    const header = truncated
      ? `--- ${file.relPath} (truncated, ${file.size} bytes) ---`
      : `--- ${file.relPath} ---`;
    if (truncated) {
      shortened.push(`${file.relPath} (${file.size} bytes, truncated)`);
    }
    const section = `${header}\n${preview}`;
    sections.push(section);
    remaining -= byteLength(section) + 2;
  }

  if (shortened.length > 0) {
    sections.push(
      listingSection({
        title: '--- files not shown in full (summary limit) ---',
        lines: shortened,
      }),
    );
  }
  if (unreadable.length > 0) {
    sections.push(
      listingSection({
        title: '--- unreadable paths (skipped) ---',
        lines: unreadable,
      }),
    );
  }

  return sections;
}

/**
 * Caps the agent response for the grader prompt, keeping its beginning and
 * end, which usually carry the plan and the final answer.
 */
export function capResponse(
  response: string,
  maxBytes = RESPONSE_BUDGET_BYTES,
): string {
  const buffer = Buffer.from(response, 'utf8');
  if (buffer.length <= maxBytes) return response;
  const half = Math.floor(maxBytes / 2);
  const head = utf8Head(buffer, half);
  const tail = utf8Tail(buffer, half);
  const omitted = buffer.length - byteLength(head) - byteLength(tail);
  return `${head}\n\n[... ${omitted} bytes of the response omitted ...]\n\n${tail}`;
}
