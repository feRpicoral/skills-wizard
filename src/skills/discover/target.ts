import { UsageError } from '../../errors.ts';
import {
  isCommitSha,
  isGitRef,
  isRepository,
  isRepositoryPath,
  WHOLE_REPOSITORY,
} from '../catalog.ts';
import {
  inspectRemoteRefs,
  type RemoteRefsInfo,
  type SourceCache,
} from '../sources.ts';
import { isSkillName, SKILL_FILE } from '../validate.ts';

export const DISCOVER_SOURCES = ['skills-sh', 'awesome', 'all'] as const;
export type DiscoverSource = (typeof DISCOVER_SOURCES)[number];

export function isDiscoverSource(value: string): value is DiscoverSource {
  return (DISCOVER_SOURCES as readonly string[]).includes(value);
}

export type ParsedSkillTarget =
  | {
      kind: 'github-path';
      repo: string;
      ref?: string;
      path: string;
      rawSegments?: readonly string[];
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

interface DecodeSegmentParams {
  segment: string;
  input: string;
}

function decodeSegment({ segment, input }: DecodeSegmentParams): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    throw new UsageError(`Malformed URL encoding in "${input}"`, {
      cause: error,
    });
  }
}

function stripGitSuffix(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
}

interface ParseRepoSkillSpecifierParams {
  rawSpec: string;
  input: string;
  reportRawRepo?: boolean;
}

function parseRepoSkillSpecifier({
  rawSpec,
  input,
  reportRawRepo = false,
}: ParseRepoSkillSpecifierParams): Extract<
  ParsedSkillTarget,
  { kind: 'repo-skill' }
> | null {
  const atIndex = rawSpec.indexOf('@');
  if (atIndex === -1) return null;
  const rawRepo = rawSpec.slice(0, atIndex);
  const repo = stripGitSuffix(rawRepo);
  const skillName = rawSpec.slice(atIndex + 1);
  if (!isRepository(repo)) {
    throw new UsageError(
      `Invalid repository "${reportRawRepo ? rawRepo : repo}" in "${input}"; expected owner/repo@skill-name`,
    );
  }
  if (!isSkillName(skillName)) {
    throw new UsageError(
      `Invalid skill name "${skillName}" in "${input}"; skill names must be lowercase letters, digits, and hyphens`,
    );
  }
  return { kind: 'repo-skill', repo, skillName };
}

function parseGithubUrl(input: string): ParsedSkillTarget {
  const normalized = /^github\.com\//i.test(input) ? `https://${input}` : input;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new UsageError(`Invalid URL "${input}"`, { cause: error });
  }
  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:' &&
    url.protocol !== 'ssh:'
  ) {
    throw new UsageError(`Unsupported URL protocol in "${input}"`);
  }
  if (url.host.toLowerCase() !== 'github.com') {
    throw new UsageError(
      `Only https://github.com/<owner>/<repo> URLs are supported, got "${input}"`,
    );
  }
  if (
    url.password ||
    (url.username && !(url.protocol === 'ssh:' && url.username === 'git'))
  ) {
    throw new UsageError(`GitHub URL must not include credentials: "${input}"`);
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeSegment({ segment: part, input }));
  const [owner, rawRepo, ...rest] = segments;
  if (!owner || !rawRepo) {
    throw new UsageError(
      `GitHub URL must include owner and repository: "${input}"`,
    );
  }
  const repoName = stripGitSuffix(rawRepo);
  const repo = `${owner}/${repoName}`;
  if (!isRepository(repo)) {
    throw new UsageError(
      `Invalid GitHub repository "${repo}" in URL "${input}"`,
    );
  }
  if (rest.length === 0) {
    return { kind: 'repo', repo };
  }
  if (url.protocol === 'ssh:') {
    throw new UsageError(
      `GitHub SSH URL must point to a repository root: "${input}"`,
    );
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
  if (route === 'blob' && (tail.length === 0 || tail.at(-1) !== SKILL_FILE)) {
    throw new UsageError(
      `GitHub blob URL must point to ${SKILL_FILE}: "${input}"`,
    );
  }
  const pathTail = tail.at(-1) === SKILL_FILE ? tail.slice(0, -1) : tail;
  const path = pathTail.length === 0 ? WHOLE_REPOSITORY : pathTail.join('/');
  if (!isRepositoryPath(path)) {
    throw new UsageError(
      `Invalid repository path "${path}" in GitHub URL "${input}"`,
    );
  }
  return {
    kind: 'github-path',
    repo,
    ref,
    path,
    rawSegments: [ref, ...pathTail],
  };
}

/**
 * Classifies a raw `add` target into a GitHub subdirectory/blob URL
 * (`github-path`), an `owner/repo@skill` shorthand (`repo-skill`), a bare
 * repository specifier (`repo`), or a free-text search query (`query`).
 *
 * @throws {UsageError} If the input is empty or contains a malformed URL,
 *   unsupported host/protocol, invalid repository name, or invalid skill name.
 */
export function parseSkillTarget(rawInput: string): ParsedSkillTarget {
  const input = rawInput.trim();
  if (input === '') {
    throw new UsageError('Skill query, repository, or URL must not be empty');
  }
  const scpMatch = /^git@([^:]+):(.+)$/i.exec(input);
  if (scpMatch) {
    const [, host = '', rawSpec = ''] = scpMatch;
    if (host.toLowerCase() !== 'github.com') {
      throw new UsageError(
        `Only https://github.com/<owner>/<repo> URLs are supported, got "${input}"`,
      );
    }
    const repoSkill = parseRepoSkillSpecifier({ rawSpec, input });
    if (repoSkill) return repoSkill;
    const repo = stripGitSuffix(rawSpec);
    if (!isRepository(repo)) {
      throw new UsageError(
        `Invalid GitHub repository "${repo}" in URL "${input}"`,
      );
    }
    return { kind: 'repo', repo };
  }
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ||
    /^github\.com(?:\/|$)/i.test(input)
  ) {
    return parseGithubUrl(input);
  }
  if (!/\s/.test(input) && input.includes('/')) {
    const repoSkill = parseRepoSkillSpecifier({
      rawSpec: input,
      input,
      reportRawRepo: true,
    });
    if (repoSkill) return repoSkill;
    const repo = stripGitSuffix(input);
    if (!isRepository(repo)) {
      throw new UsageError(
        `Invalid repository "${input}"; expected owner/repo`,
      );
    }
    return { kind: 'repo', repo };
  }
  return { kind: 'query', query: input };
}

export interface ResolveGithubPathTargetParams {
  cache: SourceCache;
  repo: string;
  ref?: string;
  path: string;
  rawSegments?: readonly string[];
  explicitRef?: string;
}

export interface ResolvedGithubPathTarget {
  ref?: string;
  path: string;
  isDefaultBranch?: boolean;
}

/**
 * Disambiguates the `<ref>/<path>` segments of a GitHub `/tree/` or `/blob/`
 * URL by matching the longest prefix against the repository's remote branches
 * and tags (`git ls-remote --symref`).
 *
 * Also determines `isDefaultBranch` so callers can avoid pinning default-branch
 * URLs when the repository is unpinned in `catalog.yaml`.
 */
export async function resolveGithubPathTarget({
  cache,
  repo,
  ref,
  path,
  rawSegments,
  explicitRef,
}: ResolveGithubPathTargetParams): Promise<ResolvedGithubPathTarget> {
  const segments =
    rawSegments ??
    (ref ? [ref, ...(path === WHOLE_REPOSITORY ? [] : path.split('/'))] : []);

  let remote: RemoteRefsInfo | undefined;
  try {
    remote = await inspectRemoteRefs(cache, repo);
  } catch {
    remote = undefined;
  }

  if (remote && segments.length >= 1) {
    for (let len = segments.length; len >= 1; len -= 1) {
      const candidateRef = segments.slice(0, len).join('/');
      if (!isGitRef(candidateRef)) continue;
      const commit = remote.refCommits.get(candidateRef);
      if (!commit) continue;
      const rest = segments.slice(len);
      const candidatePath =
        rest.length === 0 ? WHOLE_REPOSITORY : rest.join('/');
      if (!isRepositoryPath(candidatePath)) continue;
      return {
        ref: candidateRef,
        path: candidatePath,
        ...(remote.defaultBranch !== undefined
          ? { isDefaultBranch: candidateRef === remote.defaultBranch }
          : remote.headCommit !== undefined
            ? { isDefaultBranch: commit === remote.headCommit }
            : {}),
      };
    }
    if (ref && isCommitSha(ref)) {
      return {
        ref,
        path,
        ...(remote.headCommit !== undefined
          ? { isDefaultBranch: ref === remote.headCommit }
          : {}),
      };
    }
  }

  if (explicitRef !== undefined && isGitRef(explicitRef)) {
    const refParts = explicitRef.split('/');
    if (
      segments.length >= refParts.length &&
      refParts.every((part, idx) => segments[idx] === part)
    ) {
      const rest = segments.slice(refParts.length);
      const resolvedPath =
        rest.length === 0 ? WHOLE_REPOSITORY : rest.join('/');
      if (!isRepositoryPath(resolvedPath)) {
        throw new UsageError(
          `Invalid repository path "${resolvedPath}" in GitHub URL for ${repo}`,
        );
      }
      const commit = remote?.refCommits.get(explicitRef);
      return {
        ref: explicitRef,
        path: resolvedPath,
        ...(remote?.defaultBranch !== undefined
          ? { isDefaultBranch: explicitRef === remote.defaultBranch }
          : remote?.headCommit !== undefined && commit !== undefined
            ? { isDefaultBranch: commit === remote.headCommit }
            : {}),
      };
    }
  }

  return { ...(ref ? { ref } : {}), path };
}
