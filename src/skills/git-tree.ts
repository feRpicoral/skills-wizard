import { SourceError } from '../errors.ts';
import { isCommitSha } from './catalog.ts';
import { gitRaw, type SourceCache, sourceDir } from './sources.ts';

export const SYMLINK_MODE = '120000';
export const EXECUTABLE_MODE = '100755';
export const REGULAR_MODES: ReadonlySet<string> = new Set([
  '100644',
  EXECUTABLE_MODE,
]);

export interface LsTreeRecord {
  mode: string;
  type: string;
  objectHash: string;
  path: string;
}

/**
 * Parses `git ls-tree -z` output (`<mode> SP <type> SP <object> TAB <path>`
 * records separated by NUL) into structured blob records.
 */
export function parseLsTreeOutput(output: string): LsTreeRecord[] {
  const records: LsTreeRecord[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) continue;
    const meta = record.slice(0, tabIndex);
    const path = record.slice(tabIndex + 1);
    const [mode = '', type = '', objectHash = ''] = meta.split(' ');
    if (
      type === 'blob' &&
      mode.length > 0 &&
      isCommitSha(objectHash) &&
      path.length > 0
    ) {
      records.push({ mode, type, objectHash, path });
    }
  }
  return records;
}

export interface RepositoryTreeFile {
  path: string;
  blobSha: string;
}

export interface ListRepositoryFilesParams {
  cache: SourceCache;
  repo: string;
}

/**
 * Lists all regular files in `HEAD` of the cached repository for `repo` using
 * `git ls-tree -r -z --full-tree HEAD`, without widening the sparse checkout.
 */
export async function listRepositoryFiles({
  cache,
  repo,
}: ListRepositoryFilesParams): Promise<RepositoryTreeFile[]> {
  const output = await gitRaw({
    cache,
    args: ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
    failure: `Could not list files in ${repo}`,
    cwd: sourceDir(cache, repo),
  });
  return parseLsTreeOutput(output)
    .filter((entry) => REGULAR_MODES.has(entry.mode))
    .map((entry) => ({ path: entry.path, blobSha: entry.objectHash }));
}

export interface ReadRepositoryBlobParams {
  cache: SourceCache;
  repo: string;
  blobSha: string;
}

/**
 * Reads the UTF-8 contents of a git blob (`git cat-file blob <sha>`) in the
 * cached repository for `repo`.
 */
export async function readRepositoryBlob({
  cache,
  repo,
  blobSha,
}: ReadRepositoryBlobParams): Promise<string> {
  if (!isCommitSha(blobSha)) {
    throw new SourceError(`${repo}: invalid blob object id "${blobSha}"`);
  }
  return gitRaw({
    cache,
    args: ['cat-file', 'blob', blobSha],
    failure: `Could not read blob ${blobSha} in ${repo}`,
    cwd: sourceDir(cache, repo),
  });
}
