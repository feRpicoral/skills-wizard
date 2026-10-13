import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, sep } from 'node:path';

import { z } from 'zod';

import { DEFAULT_SKILLS_SH_URL } from '../env.ts';
import { FrontmatterError, SourceError, UsageError } from '../errors.ts';
import { parseFrontmatter } from '../frontmatter.ts';
import { isDirectory, readTextIfExists } from '../install/fs.ts';
import {
  isGitRef,
  isRepository,
  isRepositoryPath,
  WHOLE_REPOSITORY,
} from './catalog.ts';
import { type RiskFlag, scanSkillRisks } from './risk.ts';
import {
  ensureSource,
  listRepositoryFiles,
  readRepositoryBlob,
  type SourceCache,
  sourceCommit,
} from './sources.ts';
import {
  isSkillName,
  SKILL_FILE,
  type SkillReport,
  validateSkill,
} from './validate.ts';

export const DISCOVER_SOURCES = ['skills-sh', 'awesome', 'all'] as const;
export type DiscoverSource = (typeof DISCOVER_SOURCES)[number];

export const AWESOME_SKILLS_REPO = 'sickn33/agentic-awesome-skills';
export const AWESOME_INDEX_FILE = 'skills_index.json';

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const IGNORED_REPO_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  '.github',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'evals',
]);

export function isDiscoverSource(value: string): value is DiscoverSource {
  return (DISCOVER_SOURCES as readonly string[]).includes(value);
}

export type ParsedSkillTarget =
  | {
      kind: 'github-path';
      repo: string;
      ref?: string;
      path: string;
    }
  | {
      kind: 'repo-skill';
      repo: string;
      skillName: string;
    }
  | {
      kind: 'repo';
      repo: string;
    }
  | {
      kind: 'query';
      query: string;
    };

export interface DiscoveryCandidate {
  sourceType: 'skills-sh' | 'awesome';
  name: string;
  repo: string;
  path?: string;
  description?: string;
  category?: string;
  risk?: string;
  tags?: string[];
  installs?: number;
}

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

function decodeSegment(segment: string, input: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    throw new UsageError(`Malformed URL encoding in "${input}"`, {
      cause: error,
    });
  }
}

function parseGithubUrl(input: string): ParsedSkillTarget {
  const normalized = /^github\.com\//i.test(input) ? `https://${input}` : input;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new UsageError(`Invalid URL "${input}"`, { cause: error });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError(`Unsupported URL protocol in "${input}"`);
  }
  if (url.host.toLowerCase() !== 'github.com') {
    throw new UsageError(
      `Only https://github.com/<owner>/<repo> URLs are supported, got "${input}"`,
    );
  }
  if (url.username || url.password) {
    throw new UsageError(`GitHub URL must not include credentials: "${input}"`);
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeSegment(part, input));
  const [owner, rawRepo, ...rest] = segments;
  if (!owner || !rawRepo) {
    throw new UsageError(
      `GitHub URL must include owner and repository: "${input}"`,
    );
  }
  const repoName = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  const repo = `${owner}/${repoName}`;
  if (!isRepository(repo)) {
    throw new UsageError(
      `Invalid GitHub repository "${repo}" in URL "${input}"`,
    );
  }
  if (rest.length === 0) {
    return { kind: 'repo', repo };
  }

  const [route, ref, ...tail] = rest;
  if (route !== 'tree' && route !== 'blob') {
    throw new UsageError(
      `Unsupported GitHub URL "${input}"; expected /tree/<ref>/<path>, /blob/<ref>/<path>/${SKILL_FILE}, or repository root`,
    );
  }
  if (!ref || !isGitRef(ref)) {
    throw new UsageError(
      `Invalid git ref "${ref ?? ''}" in GitHub URL "${input}"`,
    );
  }
  if (route === 'tree') {
    const path = tail.length === 0 ? WHOLE_REPOSITORY : tail.join('/');
    if (!isRepositoryPath(path)) {
      throw new UsageError(
        `Invalid repository path "${path}" in GitHub URL "${input}"`,
      );
    }
    return { kind: 'github-path', repo, ref, path };
  }

  if (tail.length === 0 || tail.at(-1) !== SKILL_FILE) {
    throw new UsageError(
      `GitHub blob URL must point to ${SKILL_FILE}: "${input}"`,
    );
  }
  const dirParts = tail.slice(0, -1);
  const path = dirParts.length === 0 ? WHOLE_REPOSITORY : dirParts.join('/');
  if (!isRepositoryPath(path)) {
    throw new UsageError(
      `Invalid repository path "${path}" in GitHub URL "${input}"`,
    );
  }
  return { kind: 'github-path', repo, ref, path };
}

export function parseSkillTarget(rawInput: string): ParsedSkillTarget {
  const input = rawInput.trim();
  if (input === '') {
    throw new UsageError('Skill query, repository, or URL must not be empty');
  }
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ||
    /^github\.com(?:\/|$)/i.test(input)
  ) {
    return parseGithubUrl(input);
  }
  if (!/\s/.test(input) && input.includes('/')) {
    const atIndex = input.indexOf('@');
    if (atIndex !== -1) {
      const repo = input.slice(0, atIndex);
      const skillName = input.slice(atIndex + 1);
      if (!isRepository(repo)) {
        throw new UsageError(
          `Invalid repository "${repo}" in "${input}"; expected owner/repo@skill-name`,
        );
      }
      if (!isSkillName(skillName)) {
        throw new UsageError(
          `Invalid skill name "${skillName}" in "${input}"; skill names must be lowercase letters, digits, and hyphens`,
        );
      }
      return { kind: 'repo-skill', repo, skillName };
    }
    if (!isRepository(input)) {
      throw new UsageError(
        `Invalid repository "${input}"; expected owner/repo`,
      );
    }
    return { kind: 'repo', repo: input };
  }
  return { kind: 'query', query: input };
}

const skillsShItemSchema = z.looseObject({
  id: z.string().optional(),
  skillId: z.string().optional(),
  name: z.string().min(1),
  installs: z.number().int().nonnegative().default(0),
  source: z.string().min(1),
});

const skillsShResponseSchema = z.looseObject({
  skills: z.array(skillsShItemSchema),
});

export interface SearchSkillsShParams {
  query: string;
  baseUrl?: string;
  fetchFn?: typeof globalThis.fetch;
  limit?: number;
  timeoutMs?: number;
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new SourceError('skills.sh response exceeded maximum size');
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SourceError('skills.sh response exceeded maximum size');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function searchSkillsSh({
  query,
  baseUrl = DEFAULT_SKILLS_SH_URL,
  fetchFn = globalThis.fetch,
  limit = DEFAULT_SEARCH_LIMIT,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
}: SearchSkillsShParams): Promise<DiscoveryCandidate[]> {
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new UsageError('Search query must not be empty');
  }
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/search?q=${encodeURIComponent(trimmed)}&limit=${limit}`;
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SourceError(
      `Could not reach skills.sh (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new SourceError(
      `skills.sh search failed with HTTP ${response.status}`,
    );
  }

  const rawText = await readBoundedText(response);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    throw new SourceError('skills.sh returned invalid JSON', { cause: error });
  }
  const validated = skillsShResponseSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new SourceError(
      `skills.sh returned an unexpected payload: ${z.prettifyError(validated.error)}`,
    );
  }

  const seen = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];
  for (const item of validated.data.skills) {
    if (!isRepository(item.source)) continue;
    const candidateName =
      item.skillId && isSkillName(item.skillId)
        ? item.skillId
        : isSkillName(item.name)
          ? item.name
          : undefined;
    if (!candidateName) continue;
    const key = `${item.source}@${candidateName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      sourceType: 'skills-sh',
      name: candidateName,
      repo: item.source,
      installs: item.installs,
    });
  }

  return candidates.sort(
    (a, b) =>
      (b.installs ?? 0) - (a.installs ?? 0) || a.name.localeCompare(b.name),
  );
}

const awesomeItemSchema = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1),
  category: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  risk: z.string().optional(),
  source: z.string().optional(),
  date_added: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const awesomeIndexSchema = z.union([
  z.array(awesomeItemSchema),
  z
    .looseObject({ skills: z.array(awesomeItemSchema) })
    .transform((obj) => obj.skills),
]);

type AwesomeItem = z.infer<typeof awesomeItemSchema>;

function isOffensiveEntry(entry: AwesomeItem): boolean {
  return (
    entry.category.toLowerCase() === 'offensive' ||
    entry.risk?.toLowerCase() === 'offensive'
  );
}

function resolveAwesomeSkillName(entry: AwesomeItem): string | undefined {
  if (isSkillName(entry.id)) return entry.id;
  if (isSkillName(entry.name)) return entry.name;
  const folder = posix.basename(entry.path);
  return isSkillName(folder) ? folder : undefined;
}

interface MatchAwesomeEntryParams {
  entry: AwesomeItem;
  skillName: string;
  terms: readonly string[];
}

function matchesAwesomeQuery({
  entry,
  skillName,
  terms,
}: MatchAwesomeEntryParams): boolean {
  if (terms.length === 0) return true;
  const haystacks = [
    skillName.toLowerCase(),
    entry.id.toLowerCase(),
    entry.name.toLowerCase(),
    entry.description.toLowerCase(),
    entry.category.toLowerCase(),
    ...(entry.tags ?? []).map((tag) => tag.toLowerCase()),
  ];
  return terms.every((term) =>
    haystacks.some((haystack) => haystack.includes(term)),
  );
}

interface ScoreAwesomeCandidateParams {
  candidate: DiscoveryCandidate;
  normalizedQuery: string;
}

function scoreAwesomeCandidate({
  candidate,
  normalizedQuery,
}: ScoreAwesomeCandidateParams): number {
  if (!normalizedQuery) return 2;
  const name = candidate.name.toLowerCase();
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 1;
  return 2;
}

export interface SearchAwesomeIndexParams {
  cache: SourceCache;
  query?: string;
  category?: string;
  includeOffensive?: boolean;
  repo?: string;
}

export async function searchAwesomeIndex({
  cache,
  query,
  category,
  includeOffensive = false,
  repo = AWESOME_SKILLS_REPO,
}: SearchAwesomeIndexParams): Promise<DiscoveryCandidate[]> {
  const root = await ensureSource(cache, { repo, paths: [] });
  const indexFile = join(root, AWESOME_INDEX_FILE);
  const rawContent = await readTextIfExists(indexFile);
  if (rawContent === null) {
    throw new SourceError(`${repo} does not contain ${AWESOME_INDEX_FILE}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (error) {
    throw new SourceError(`${repo}/${AWESOME_INDEX_FILE} is not valid JSON`, {
      cause: error,
    });
  }
  const validated = awesomeIndexSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new SourceError(
      `${repo}/${AWESOME_INDEX_FILE} is invalid: ${z.prettifyError(validated.error)}`,
    );
  }

  const normalizedQuery = query?.trim().toLowerCase() ?? '';
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const normalizedCategory = category?.trim().toLowerCase();

  const candidates: DiscoveryCandidate[] = [];
  for (const entry of validated.data) {
    if (!isRepositoryPath(entry.path)) continue;
    const skillName = resolveAwesomeSkillName(entry);
    if (!skillName) continue;
    if (!includeOffensive && isOffensiveEntry(entry)) continue;
    if (
      normalizedCategory &&
      entry.category.toLowerCase() !== normalizedCategory
    ) {
      continue;
    }
    if (!matchesAwesomeQuery({ entry, skillName, terms })) continue;
    candidates.push({
      sourceType: 'awesome',
      name: skillName,
      repo,
      path: entry.path,
      description: entry.description,
      category: entry.category,
      ...(entry.risk ? { risk: entry.risk } : {}),
      ...(entry.tags ? { tags: entry.tags } : {}),
    });
  }

  return candidates.sort(
    (a, b) =>
      scoreAwesomeCandidate({ candidate: a, normalizedQuery }) -
        scoreAwesomeCandidate({ candidate: b, normalizedQuery }) ||
      a.name.localeCompare(b.name),
  );
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

function parseSkillMetadata(markdown: string): {
  name: string;
  description: string;
  license?: string;
} | null {
  try {
    const { data } = parseFrontmatter({ source: markdown, file: SKILL_FILE });
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return null;
    }
    const record = data as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const description =
      typeof record.description === 'string' ? record.description.trim() : '';
    const license =
      typeof record.license === 'string' && record.license.trim() !== ''
        ? record.license.trim()
        : undefined;
    if (!isSkillName(name) || description === '') return null;
    return { name, description, ...(license ? { license } : {}) };
  } catch (error) {
    if (error instanceof FrontmatterError) return null;
    throw error;
  }
}

export interface LocateSkillsInRepoParams {
  cache: SourceCache;
  repo: string;
  ref?: string;
  expectedSkillName?: string;
  existingPaths?: readonly string[];
}

export async function locateSkillsInRepo({
  cache,
  repo,
  ref,
  expectedSkillName,
  existingPaths = [],
}: LocateSkillsInRepoParams): Promise<RepoSkillLocation[]> {
  await ensureSource(cache, {
    repo,
    ...(ref ? { ref } : {}),
    paths: existingPaths,
  });
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

  candidates.sort(
    (a, b) =>
      rankSkillPath({ dirPath: a.dirPath, expectedSkillName }) -
        rankSkillPath({ dirPath: b.dirPath, expectedSkillName }) ||
      a.dirPath.localeCompare(b.dirPath),
  );

  if (expectedSkillName !== undefined) {
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

interface AssertInsideRepoParams {
  repoRoot: string;
  skillDir: string;
  repo: string;
  path: string;
}

async function assertInsideRepository({
  repoRoot,
  skillDir,
  repo,
  path,
}: AssertInsideRepoParams): Promise<void> {
  if (!(await isDirectory(skillDir))) {
    throw new SourceError(`${repo} does not contain skill directory "${path}"`);
  }
  const [realRoot, realSkill] = await Promise.all([
    realpath(repoRoot),
    realpath(skillDir),
  ]);
  const rel = relative(realRoot, realSkill);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
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
  const wantedPaths = existingPaths.includes(WHOLE_REPOSITORY)
    ? [WHOLE_REPOSITORY]
    : [...new Set([...existingPaths, path])];
  const root = await ensureSource(cache, {
    repo,
    ...(ref ? { ref } : {}),
    paths: wantedPaths,
  });
  const dir = path === WHOLE_REPOSITORY ? root : join(root, ...path.split('/'));
  await assertInsideRepository({ repoRoot: root, skillDir: dir, repo, path });

  const report = await validateSkill(dir, {
    strict: false,
    ...(expectedName !== undefined ? { expectedName } : {}),
  });
  if (report.errors.length > 0 || !report.name) {
    throw new SourceError(
      `Invalid skill in ${repo} (${path}): ${report.errors.join('; ')}`,
    );
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
    ...(ref ? { ref } : {}),
    commit,
    dir,
    ...(category ? { category } : {}),
    report,
    risks,
  };
}
