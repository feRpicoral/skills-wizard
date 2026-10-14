import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, sep } from 'node:path';

import { z } from 'zod';

import { FrontmatterError, SourceError } from '../../errors.ts';
import { parseFrontmatter } from '../../frontmatter.ts';
import {
  isDirectory,
  lstatIfExists,
  readTextIfExists,
} from '../../install/fs.ts';
import { isRepositoryPath, WHOLE_REPOSITORY } from '../catalog.ts';
import { type RiskFlag, scanSkillRisks } from '../risk.ts';
import {
  cachedSourceRef,
  ensureSource,
  listRepositoryFiles,
  readRepositoryBlob,
  restoreSourceCheckout,
  snapshotSourceCheckout,
  type SourceCache,
  sourceCommit,
} from '../sources.ts';
import {
  isSkillName,
  SKILL_FILE,
  type SkillReport,
  validateSkill,
} from '../validate.ts';

const IGNORED_REPO_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.github',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'evals',
]);

export interface RepoSkillLocation {
  name: string;
  path: string;
  description: string;
  license?: string;
}

export interface ResolvedDiscoveredSkill {
  name: string;
  description: string;
  license?: string;
  repo: string;
  path: string;
  ref?: string;
  commit: string;
  dir: string;
  category?: string;
  report: SkillReport;
  risks: RiskFlag[];
}

interface CandidateSkillFile {
  dirPath: string;
  blobSha: string;
}

function isEligibleSkillDirPath(dirPath: string): boolean {
  if (!isRepositoryPath(dirPath)) return false;
  if (dirPath === WHOLE_REPOSITORY) return true;

  return dirPath
    .split('/')
    .every((segment) => !IGNORED_REPO_SEGMENTS.has(segment));
}

interface RankSkillPathParams {
  dirPath: string;
  expectedSkillName: string | undefined;
}

function rankSkillPath({
  dirPath,
  expectedSkillName,
}: RankSkillPathParams): number {
  if (expectedSkillName !== undefined) {
    if (posix.basename(dirPath) === expectedSkillName) return 0;
    if (dirPath === WHOLE_REPOSITORY) return 1;
  } else if (dirPath === WHOLE_REPOSITORY) {
    return 0;
  }

  return 2 + dirPath.split('/').length;
}

const skillMetadataSchema = z.looseObject({
  name: z.string().trim().refine(isSkillName),
  description: z.string().trim().min(1),
  license: z
    .string()
    .trim()
    .transform((val) => (val === '' ? undefined : val))
    .optional(),
});

function parseSkillMetadata(
  markdown: string,
): z.infer<typeof skillMetadataSchema> | null {
  try {
    const { data } = parseFrontmatter({ source: markdown, file: SKILL_FILE });
    const parsed = skillMetadataSchema.safeParse(data);

    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof FrontmatterError) return null;

    throw error;
  }
}

interface ListCandidateSkillBlobsParams {
  cache: SourceCache;
  repo: string;
  expectedSkillName: string | undefined;
}

async function listCandidateSkillBlobs({
  cache,
  repo,
  expectedSkillName,
}: ListCandidateSkillBlobsParams): Promise<CandidateSkillFile[]> {
  const treeFiles = await listRepositoryFiles({ cache, repo });
  const candidates: CandidateSkillFile[] = [];

  for (const file of treeFiles) {
    if (file.path !== SKILL_FILE && !file.path.endsWith(`/${SKILL_FILE}`)) {
      continue;
    }

    const dirPath =
      file.path === SKILL_FILE
        ? WHOLE_REPOSITORY
        : file.path.slice(0, -(SKILL_FILE.length + 1));

    if (!isEligibleSkillDirPath(dirPath)) continue;

    candidates.push({ dirPath, blobSha: file.blobSha });
  }

  return candidates.sort(
    (a, b) =>
      rankSkillPath({ dirPath: a.dirPath, expectedSkillName }) -
        rankSkillPath({ dirPath: b.dirPath, expectedSkillName }) ||
      a.dirPath.localeCompare(b.dirPath),
  );
}

interface FindMatchingSkillInRepoParams {
  cache: SourceCache;
  repo: string;
  candidates: readonly CandidateSkillFile[];
  expectedSkillName: string;
}

async function findMatchingSkillInRepo({
  cache,
  repo,
  candidates,
  expectedSkillName,
}: FindMatchingSkillInRepoParams): Promise<RepoSkillLocation[]> {
  const matches: RepoSkillLocation[] = [];
  const exactFolderCandidates = candidates.filter(
    (candidate) => posix.basename(candidate.dirPath) === expectedSkillName,
  );
  const otherCandidates = candidates.filter(
    (candidate) => posix.basename(candidate.dirPath) !== expectedSkillName,
  );

  for (const group of [exactFolderCandidates, otherCandidates]) {
    for (const candidate of group) {
      const content = await readRepositoryBlob({
        cache,
        repo,
        blobSha: candidate.blobSha,
      });
      const meta = parseSkillMetadata(content);
      if (meta?.name !== expectedSkillName) continue;

      matches.push({
        name: meta.name,
        path: candidate.dirPath,
        description: meta.description,
        ...(meta.license ? { license: meta.license } : {}),
      });
    }

    if (matches.length > 0) break;
  }

  if (matches.length === 1 && matches[0]) return [matches[0]];
  if (matches.length > 1) {
    throw new SourceError(
      `Skill "${expectedSkillName}" matched multiple paths in ${repo}: ${matches.map((m) => m.path).join(', ')}`,
    );
  }

  throw new SourceError(
    `Skill "${expectedSkillName}" was not found in ${repo}`,
  );
}

interface ListAllSkillsInRepoParams {
  cache: SourceCache;
  repo: string;
  candidates: readonly CandidateSkillFile[];
}

async function listAllSkillsInRepo({
  cache,
  repo,
  candidates,
}: ListAllSkillsInRepoParams): Promise<RepoSkillLocation[]> {
  const locations: RepoSkillLocation[] = [];
  const seenNames = new Map<string, string>();

  for (const candidate of candidates) {
    const content = await readRepositoryBlob({
      cache,
      repo,
      blobSha: candidate.blobSha,
    });
    const meta = parseSkillMetadata(content);
    if (!meta) continue;

    const priorPath = seenNames.get(meta.name);

    if (priorPath !== undefined) {
      throw new SourceError(
        `${repo} defines skill "${meta.name}" in both ${priorPath} and ${candidate.dirPath}`,
      );
    }

    seenNames.set(meta.name, candidate.dirPath);
    locations.push({
      name: meta.name,
      path: candidate.dirPath,
      description: meta.description,
      ...(meta.license ? { license: meta.license } : {}),
    });
  }

  if (locations.length === 0) {
    throw new SourceError(`No valid ${SKILL_FILE} found in ${repo}`);
  }

  return locations.sort((a, b) => a.name.localeCompare(b.name));
}

export interface LocateSkillsInRepoParams {
  cache: SourceCache;
  repo: string;
  ref?: string;
  expectedSkillName?: string;
  existingPaths?: readonly string[];
}

/**
 * Scans the git tree of `repo` (`git ls-tree --full-tree HEAD`) for eligible
 * `SKILL.md` blobs and parses their frontmatter without widening the working
 * tree's sparse-checkout cone.
 *
 * When `expectedSkillName` is provided, prefers a directory whose basename
 * matches `expectedSkillName` before falling back to other directories.
 *
 * @throws {SourceError} If no matching valid skill is found or if multiple
 *   paths declare the same skill name.
 */
export async function locateSkillsInRepo({
  cache,
  repo,
  ref,
  expectedSkillName,
  existingPaths = [],
}: LocateSkillsInRepoParams): Promise<RepoSkillLocation[]> {
  const effectiveRef = ref ?? (await cachedSourceRef(cache, repo));

  await ensureSource(cache, {
    repo,
    ref: effectiveRef || undefined,
    paths: existingPaths,
  });

  const candidates = await listCandidateSkillBlobs({
    cache,
    repo,
    expectedSkillName,
  });

  if (expectedSkillName !== undefined) {
    return findMatchingSkillInRepo({
      cache,
      repo,
      candidates,
      expectedSkillName,
    });
  }

  return listAllSkillsInRepo({ cache, repo, candidates });
}

export interface AssertInsideRepoParams {
  repoRoot: string;
  skillDir: string;
  repo: string;
  path: string;
}

/**
 * Verifies that `skillDir` is a real directory inside `repoRoot` at `path`
 * without symlink escapes.
 */
export async function assertInsideRepository({
  repoRoot,
  skillDir,
  repo,
  path,
}: AssertInsideRepoParams): Promise<void> {
  if (!(await isDirectory(skillDir))) {
    throw new SourceError(`${repo} does not contain skill directory "${path}"`);
  }

  const skillStat = await lstatIfExists(skillDir);

  if (!skillStat?.isDirectory()) {
    throw new SourceError(
      `${repo}: skill path "${path}" must be a directory, not a symlink`,
    );
  }

  const [realRoot, realSkill] = await Promise.all([
    realpath(repoRoot),
    realpath(skillDir),
  ]);
  const expectedRealSkill =
    path === WHOLE_REPOSITORY ? realRoot : join(realRoot, ...path.split('/'));
  const rel = relative(realRoot, realSkill);

  if (
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    realSkill !== expectedRealSkill
  ) {
    throw new SourceError(
      `${repo}: skill path "${path}" resolves outside the repository`,
    );
  }
}

export interface InspectDiscoveredSkillParams {
  cache: SourceCache;
  repo: string;
  path: string;
  ref?: string;
  expectedName?: string;
  category?: string;
  existingPaths?: readonly string[];
}

/**
 * Materializes `path` in the cached sparse checkout of `repo`, verifies that
 * the resolved directory stays inside the repository root without symlink
 * escapes, validates `SKILL.md` in non-strict mode, and scans for risk flags.
 *
 * Restores the prior sparse-checkout snapshot if materialization or
 * validation fails.
 */
export async function inspectDiscoveredSkill({
  cache,
  repo,
  path,
  ref,
  expectedName,
  category,
  existingPaths = [],
}: InspectDiscoveredSkillParams): Promise<ResolvedDiscoveredSkill> {
  if (!isRepositoryPath(path)) {
    throw new SourceError(`${repo}: "${path}" is not a valid repository path`);
  }

  const effectiveRef = ref ?? (await cachedSourceRef(cache, repo));
  const wantedPaths = existingPaths.includes(WHOLE_REPOSITORY)
    ? [WHOLE_REPOSITORY]
    : [...new Set([...existingPaths, path])];
  const snapshot = await snapshotSourceCheckout(cache, repo);
  let root: string;
  let dir: string;
  let report: SkillReport;

  try {
    root = await ensureSource(cache, {
      repo,
      ref: effectiveRef || undefined,
      paths: wantedPaths,
    });
    dir = path === WHOLE_REPOSITORY ? root : join(root, ...path.split('/'));
    await assertInsideRepository({ repoRoot: root, skillDir: dir, repo, path });

    report = await validateSkill(dir, {
      strict: false,
      expectedName,
    });

    if (report.errors.length > 0 || !report.name) {
      throw new SourceError(
        `Invalid skill in ${repo} (${path}): ${report.errors.join('; ')}`,
      );
    }
  } catch (error) {
    await restoreSourceCheckout(cache, snapshot);

    throw error;
  }

  const rawSkill = await readTextIfExists(join(dir, SKILL_FILE));
  const meta = rawSkill ? parseSkillMetadata(rawSkill) : null;
  const description = meta?.description ?? basename(dir);
  const risks = await scanSkillRisks({ previousDir: null, nextDir: dir });
  const commit = await sourceCommit(cache, repo);

  return {
    name: report.name,
    description,
    ...(meta?.license ? { license: meta.license } : {}),
    repo,
    path,
    ...(effectiveRef ? { ref: effectiveRef } : {}),
    commit,
    dir,
    ...(category ? { category } : {}),
    report,
    risks,
  };
}
