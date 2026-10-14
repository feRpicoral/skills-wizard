import { basename, join } from 'node:path';

import { isSystemError } from '../errors.ts';
import { isInside, readDirIfExists } from '../install/fs.ts';
import { readProjectFile, safeRealLocation } from './boundary-fs.ts';
import { parsePackageJson } from './manifests.ts';

export interface WorkspacePackageInfo {
  relativePath: string;
  name: string;
  description?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

interface ParsedWorkspacePattern {
  pattern: string;
  negated: boolean;
}

const MAX_WORKSPACE_DEPTH = 5;

function parseWorkspacePattern(raw: string): ParsedWorkspacePattern | null {
  let trimmed = raw.trim();
  const negated = trimmed.startsWith('!');
  if (negated) {
    trimmed = trimmed.slice(1).trim();
  }
  trimmed = trimmed.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (
    !trimmed ||
    trimmed.startsWith('!') ||
    trimmed.startsWith('/') ||
    trimmed.split('/').includes('..')
  ) {
    return null;
  }
  return { pattern: trimmed, negated };
}

function hasGlobChars(segment: string): boolean {
  return (
    segment.includes('*') || segment.includes('?') || segment.includes('[')
  );
}

function globSegmentToRegExp(segment: string): RegExp {
  let regex = '^';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (ch === '*') {
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else {
      regex += RegExp.escape(ch);
    }
  }
  regex += '$';
  return new RegExp(regex);
}

function matchesWorkspacePattern(relPath: string, pattern: string): boolean {
  if (relPath === pattern || relPath.startsWith(`${pattern}/`)) {
    return true;
  }
  const pathSegments = relPath.split('/').filter(Boolean);
  const patternSegments = pattern.split('/').filter(Boolean);

  function matchAt(pIdx: number, sIdx: number): boolean {
    if (pIdx === patternSegments.length) {
      return sIdx === pathSegments.length;
    }
    const pat = patternSegments[pIdx]!;
    if (pat === '**') {
      if (pIdx === patternSegments.length - 1) return true;
      for (let next = sIdx; next <= pathSegments.length; next += 1) {
        if (matchAt(pIdx + 1, next)) return true;
      }
      return false;
    }
    if (sIdx >= pathSegments.length) return false;
    const seg = pathSegments[sIdx]!;
    const segMatches = hasGlobChars(pat)
      ? globSegmentToRegExp(pat).test(seg)
      : pat === seg;
    return segMatches && matchAt(pIdx + 1, sIdx + 1);
  }

  return matchAt(0, 0);
}

export async function readWorkspacePackage(
  projectDir: string,
  relPkgDir: string,
  root?: string,
): Promise<WorkspacePackageInfo | null> {
  const pkgJsonSource = await readProjectFile({
    projectDir,
    relativePath: `${relPkgDir}/package.json`,
    ...(root !== undefined ? { root } : {}),
  });
  if (pkgJsonSource === null) return null;
  const parsed = parsePackageJson(pkgJsonSource);
  if (!parsed) return null;
  const fallbackName = basename(relPkgDir);
  return {
    relativePath: relPkgDir,
    name: parsed.name ?? fallbackName,
    ...(parsed.description !== undefined
      ? { description: parsed.description }
      : {}),
    scripts: parsed.scripts,
    dependencies: parsed.dependencies,
  };
}

interface ExpandContext {
  root: string;
  segments: readonly string[];
  candidates: string[];
}

async function listSubdirectories(
  root: string,
  relDir: string,
): Promise<string[]> {
  const targetPath = relDir ? join(root, relDir) : root;
  const dirLocation = await safeRealLocation(targetPath);
  if (dirLocation === null || !isInside({ dir: root, path: dirLocation })) {
    return [];
  }
  let entries;
  try {
    entries = await readDirIfExists(dirLocation);
  } catch (error) {
    if (isSystemError(error)) return [];
    throw error;
  }
  if (!entries) return [];
  return [...entries]
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function expandPatternSegments(
  ctx: ExpandContext,
  currentRel: string,
  segIdx: number,
  depth: number,
): Promise<void> {
  if (depth > MAX_WORKSPACE_DEPTH) return;
  if (segIdx >= ctx.segments.length) {
    if (currentRel) ctx.candidates.push(currentRel);
    return;
  }

  const segment = ctx.segments[segIdx]!;
  if (segment === '**') {
    await expandPatternSegments(ctx, currentRel, segIdx + 1, depth);
    const children = await listSubdirectories(ctx.root, currentRel);
    for (const child of children) {
      const nextRel = currentRel ? `${currentRel}/${child}` : child;
      await expandPatternSegments(ctx, nextRel, segIdx, depth + 1);
    }
    return;
  }

  if (!hasGlobChars(segment)) {
    const nextRel = currentRel ? `${currentRel}/${segment}` : segment;
    const dirLocation = await safeRealLocation(join(ctx.root, nextRel));
    if (
      dirLocation === null ||
      !isInside({ dir: ctx.root, path: dirLocation })
    ) {
      return;
    }
    await expandPatternSegments(ctx, nextRel, segIdx + 1, depth + 1);
    return;
  }

  const matcher = globSegmentToRegExp(segment);
  const children = await listSubdirectories(ctx.root, currentRel);
  for (const child of children) {
    if (!matcher.test(child)) continue;
    const nextRel = currentRel ? `${currentRel}/${child}` : child;
    await expandPatternSegments(ctx, nextRel, segIdx + 1, depth + 1);
  }
}

export interface DiscoverWorkspacesParams {
  projectDir: string;
  root?: string;
  patterns: readonly string[];
  hasNx: boolean;
}

export async function discoverWorkspaces({
  projectDir,
  root: givenRoot,
  patterns,
  hasNx,
}: DiscoverWorkspacesParams): Promise<WorkspacePackageInfo[]> {
  const effectivePatterns =
    patterns.length > 0
      ? patterns
      : hasNx
        ? ['apps/*', 'packages/*', 'libs/*']
        : [];
  if (effectivePatterns.length === 0) return [];

  const root = givenRoot ?? (await safeRealLocation(projectDir)) ?? projectDir;
  const parsedPatterns = effectivePatterns
    .map(parseWorkspacePattern)
    .filter((item): item is ParsedWorkspacePattern => item !== null);
  const exclusions = parsedPatterns
    .filter((item) => item.negated)
    .map((item) => item.pattern);
  const inclusions = parsedPatterns
    .filter((item) => !item.negated)
    .map((item) => item.pattern);

  const seen = new Set<string>();
  const discovered: WorkspacePackageInfo[] = [];

  for (const pattern of inclusions) {
    const segments = pattern.split('/').filter(Boolean);
    const candidates: string[] = [];
    await expandPatternSegments({ root, segments, candidates }, '', 0, 0);

    for (const relPkgDir of candidates) {
      if (seen.has(relPkgDir)) continue;
      if (exclusions.some((ex) => matchesWorkspacePattern(relPkgDir, ex))) {
        continue;
      }
      const info = await readWorkspacePackage(projectDir, relPkgDir, root);
      if (info) {
        seen.add(relPkgDir);
        discovered.push(info);
      }
    }
  }

  return discovered;
}
