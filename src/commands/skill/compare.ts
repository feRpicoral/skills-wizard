import { realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { Context } from '../../context.ts';
import { SourceError, UsageError } from '../../errors.ts';
import type { ComparedSkillSpec } from '../../evals/workspace.ts';
import { statIfExists } from '../../install/fs.ts';
import {
  type CatalogEntry,
  repositoryPaths,
  WHOLE_REPOSITORY,
} from '../../skills/catalog.ts';
import { assertInsideRepository } from '../../skills/discover.ts';
import { loadSkillLibrary } from '../../skills/library.ts';
import { ensureSource } from '../../skills/sources.ts';
import { escapingLinks } from '../../skills/tree.ts';
import { isSkillName, validateSkill } from '../../skills/validate.ts';
import { sourceCache } from '../shared.ts';

interface AssertSafeComparedSkillDirParams {
  skillDir: string;
  label: string;
}

async function assertSafeComparedSkillDir({
  skillDir,
  label,
}: AssertSafeComparedSkillDirParams): Promise<void> {
  const escaping = await escapingLinks(skillDir);
  if (escaping.length > 0) {
    throw new UsageError(
      `Compared skill "${label}" has links that point outside the skill folder: ${escaping.map((link) => `${link.path} -> ${link.target}`).join(', ')}`,
    );
  }
}

interface ResolveComparedSkillParams {
  ctx: Context;
  nameOrPath: string;
}

async function tryResolveLocalComparedSkill({
  ctx,
  nameOrPath,
}: ResolveComparedSkillParams): Promise<ComparedSkillSpec | null> {
  const candidates = isSkillName(nameOrPath)
    ? [
        join(ctx.cwd, 'skills', nameOrPath),
        join(ctx.repoRoot, 'skills', nameOrPath),
        join(ctx.paths.skillsDir, nameOrPath),
      ]
    : [];
  for (const dir of candidates) {
    if ((await statIfExists(join(dir, 'SKILL.md')))?.isFile()) {
      await assertSafeComparedSkillDir({ skillDir: dir, label: nameOrPath });
      const report = await validateSkill(dir, { strict: false });
      const skillName =
        report.name && isSkillName(report.name) ? report.name : nameOrPath;
      return { skillName, skillDir: dir };
    }
  }
  const resolved = resolve(ctx.cwd, nameOrPath);
  if ((await statIfExists(join(resolved, 'SKILL.md')))?.isFile()) {
    await assertSafeComparedSkillDir({ skillDir: resolved, label: nameOrPath });
    const report = await validateSkill(resolved, { strict: false });
    const fallbackName = basename(resolved);
    const skillName =
      report.name && isSkillName(report.name)
        ? report.name
        : isSkillName(fallbackName)
          ? fallbackName
          : undefined;
    if (!skillName) {
      throw new UsageError(
        `Compared skill directory "${nameOrPath}" does not have a valid skill name`,
      );
    }
    return { skillName, skillDir: resolved };
  }
  return null;
}

interface ResolveCatalogComparedSkillParams {
  ctx: Context;
  entry: CatalogEntry;
  paths: readonly string[];
}

async function resolveCatalogComparedSkill({
  ctx,
  entry,
  paths,
}: ResolveCatalogComparedSkillParams): Promise<ComparedSkillSpec> {
  const root = await ensureSource(sourceCache(ctx), {
    repo: entry.repo,
    ref: entry.ref || undefined,
    paths,
  });
  const skillDir =
    entry.path === WHOLE_REPOSITORY
      ? root
      : join(root, ...entry.path.split('/'));
  await assertInsideRepository({
    repoRoot: root,
    skillDir,
    repo: entry.repo,
    path: entry.path,
  });
  await assertSafeComparedSkillDir({ skillDir, label: entry.name });
  const report = await validateSkill(skillDir, {
    strict: false,
    expectedName: entry.name,
  });
  if (report.errors.length > 0) {
    throw new SourceError(
      `Invalid compared skill "${entry.name}" in ${entry.repo} (${entry.path}): ${report.errors.join('; ')}`,
    );
  }
  return {
    skillName: entry.name,
    skillDir,
    ...(entry.setup ? { setup: entry.setup } : {}),
  };
}

async function resolveComparedSkill({
  ctx,
  nameOrPath,
}: ResolveComparedSkillParams): Promise<ComparedSkillSpec> {
  const local = await tryResolveLocalComparedSkill({ ctx, nameOrPath });
  if (local !== null) return local;

  if (isSkillName(nameOrPath)) {
    const library = await loadSkillLibrary(ctx.repoRoot);
    const entry = library.catalog.skills.find(
      (item) => item.name === nameOrPath,
    );
    if (entry !== undefined) {
      return resolveCatalogComparedSkill({
        ctx,
        entry,
        paths: repositoryPaths(library.catalog, entry.repo),
      });
    }
  }

  throw new UsageError(
    `Compared skill "${nameOrPath}" was not found in skills/, catalog.yaml, or on disk`,
  );
}

function isPathLikeCompareTarget(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.includes('\\')
  );
}

interface CollectComparedSkillsParams {
  ctx: Context;
  items: readonly string[];
  primarySkillName: string;
  primaryRealDir: string;
}

async function collectComparedSkills({
  ctx,
  items,
  primarySkillName,
  primaryRealDir,
}: CollectComparedSkillsParams): Promise<ComparedSkillSpec[]> {
  if (items.some((item) => item === '')) {
    throw new UsageError('--compare skill list must not contain empty entries');
  }
  const compareSkills: ComparedSkillSpec[] = [];
  const seenRealDirs = new Set<string>();
  const seenNames = new Set<string>();
  for (const item of items) {
    if (item === primarySkillName) {
      throw new UsageError(
        `Cannot compare skill "${primarySkillName}" against itself; use --compare <ref> to compare two revisions of the same skill`,
      );
    }
    const resolved = await resolveComparedSkill({
      ctx,
      nameOrPath: item,
    });
    const realDir = await realpath(resolved.skillDir);
    if (realDir === primaryRealDir || resolved.skillName === primarySkillName) {
      throw new UsageError(
        `Cannot compare skill "${primarySkillName}" against itself ("${item}"); use --compare <ref> to compare two revisions of the same skill`,
      );
    }
    if (seenRealDirs.has(realDir) || seenNames.has(resolved.skillName)) {
      throw new UsageError(
        `Duplicate compared skill "${resolved.skillName}" in --compare`,
      );
    }
    seenRealDirs.add(realDir);
    seenNames.add(resolved.skillName);
    compareSkills.push(resolved);
  }
  return compareSkills;
}

export interface ResolveCompareSpecParams {
  ctx: Context;
  primarySkillName: string;
  primarySkillDir: string;
  compare: string | undefined;
  forceCompareRef: boolean;
}

export interface ResolvedCompareSpec {
  compareRef?: string;
  compareSkills?: ComparedSkillSpec[];
}

/**
 * Resolves the `--compare` argument for `skill eval` into either a git
 * `compareRef` (`old_skill`) or a list of competing `compareSkills`.
 *
 * Comma-separated values always resolve as skills. A single token resolves as
 * a git ref when `forceCompareRef` is set or prefixed with `ref:`, as a skill
 * if it matches a local or catalog skill, or as a git ref otherwise.
 */
export async function resolveCompareSpec({
  ctx,
  primarySkillName,
  primarySkillDir,
  compare,
  forceCompareRef,
}: ResolveCompareSpecParams): Promise<ResolvedCompareSpec> {
  if (compare === undefined) return {};
  if (forceCompareRef) return { compareRef: compare };
  if (compare.startsWith('ref:')) {
    const explicitRef = compare.slice('ref:'.length).trim();
    if (explicitRef === '') {
      throw new UsageError('--compare ref:<ref> requires a non-empty git ref');
    }
    return { compareRef: explicitRef };
  }
  const primaryRealDir = await realpath(primarySkillDir);

  if (compare.includes(',')) {
    const rawItems = compare.split(',').map((item) => item.trim());
    return {
      compareSkills: await collectComparedSkills({
        ctx,
        items: rawItems,
        primarySkillName,
        primaryRealDir,
      }),
    };
  }

  if (compare === primarySkillName) {
    throw new UsageError(
      `Cannot compare skill "${primarySkillName}" against itself; use --compare <ref> to compare two revisions of the same skill`,
    );
  }

  const singleLocal = await tryResolveLocalComparedSkill({
    ctx,
    nameOrPath: compare,
  });
  if (singleLocal !== null || isPathLikeCompareTarget(compare)) {
    return {
      compareSkills: await collectComparedSkills({
        ctx,
        items: [compare],
        primarySkillName,
        primaryRealDir,
      }),
    };
  }

  if (isSkillName(compare)) {
    const library = await loadSkillLibrary(ctx.repoRoot);
    const entry = library.catalog.skills.find((item) => item.name === compare);
    if (entry !== undefined) {
      return {
        compareSkills: await collectComparedSkills({
          ctx,
          items: [compare],
          primarySkillName,
          primaryRealDir,
        }),
      };
    }
  }

  return { compareRef: compare };
}
