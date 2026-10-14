import { join, resolve } from 'node:path';
import { styleText } from 'node:util';

import type { Context } from '../../context.ts';
import { SourceError, UsageError } from '../../errors.ts';
import { displayPath } from '../../install/describe.ts';
import {
  type CatalogEntry,
  repositoryPaths,
  WHOLE_REPOSITORY,
} from '../../skills/catalog.ts';
import { loadSkillLibrary } from '../../skills/library.ts';
import { ensureSource } from '../../skills/sources.ts';
import { type SkillReport, validateSkill } from '../../skills/validate.ts';
import { sourceCache } from '../shared.ts';
import type { SkillCommandOptions } from '../skill.ts';

const OK_LABEL = styleText('green', 'ok   ');
const WARN_LABEL = styleText('yellow', 'warn ');
const ERROR_LABEL = styleText('red', 'error');

interface PrintReportParams {
  ctx: Context;
  label: string;
  report: SkillReport;
}

export function printReport({ ctx, label, report }: PrintReportParams): void {
  if (report.errors.length === 0 && report.warnings.length === 0) {
    ctx.print(`${OK_LABEL}  ${label}`);
    return;
  }
  for (const warning of report.warnings) {
    ctx.print(`${WARN_LABEL}  ${label}: ${warning}`);
  }
  for (const error of report.errors) {
    ctx.print(`${ERROR_LABEL}  ${label}: ${error}`);
  }
}

export async function validateCatalog(ctx: Context): Promise<SkillReport[]> {
  const library = await loadSkillLibrary(ctx.repoRoot);
  const cache = sourceCache(ctx);
  const byRepo = new Map<string, CatalogEntry[]>();
  for (const entry of library.catalog.skills) {
    byRepo.set(entry.repo, [...(byRepo.get(entry.repo) ?? []), entry]);
  }

  const reports: SkillReport[] = [];
  for (const [repo, entries] of byRepo) {
    const [first] = entries;
    if (!first) continue;
    let root: string;
    try {
      root = await ensureSource(cache, {
        repo,
        ref: first.ref || undefined,
        paths: repositoryPaths(library.catalog, repo),
      });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      for (const entry of entries) {
        const report: SkillReport = {
          dir: repo,
          name: entry.name,
          errors: [error.message],
          warnings: [],
        };
        printReport({ ctx, label: `${entry.name} (${repo})`, report });
        reports.push(report);
      }
      continue;
    }

    for (const entry of entries) {
      const dir =
        entry.path === WHOLE_REPOSITORY ? root : join(root, entry.path);
      const report = await validateSkill(dir, {
        strict: false,
        expectedName: entry.name,
      });
      printReport({ ctx, label: `${entry.name} (${repo})`, report });
      reports.push(report);
    }
  }
  return reports;
}

export async function validatePaths(
  ctx: Context,
  requested: readonly string[],
): Promise<SkillReport[]> {
  const dirs =
    requested.length > 0
      ? requested.map((item) => resolve(ctx.cwd, item))
      : (await loadSkillLibrary(ctx.repoRoot)).skills.flatMap((skill) =>
          skill.origin.type === 'local' ? [skill.origin.dir] : [],
        );
  if (dirs.length === 0) {
    ctx.print(
      'No first-party skills in skills/; pass a skill directory or --catalog.',
    );
    return [];
  }

  const reports: SkillReport[] = [];
  for (const dir of dirs) {
    const report = await validateSkill(dir, { strict: true });
    const label =
      report.name ?? displayPath({ path: dir, home: ctx.paths.home });
    printReport({ ctx, label, report });
    reports.push(report);
  }
  return reports;
}

export async function runSkillValidate(
  ctx: Context,
  { catalog = false, paths }: SkillCommandOptions,
): Promise<number> {
  if (catalog && paths.length > 0) {
    throw new UsageError('Use either skill paths or --catalog, not both.');
  }
  const reports = catalog
    ? await validateCatalog(ctx)
    : await validatePaths(ctx, paths);
  if (reports.length === 0) return 0;

  const errors = reports.reduce((sum, item) => sum + item.errors.length, 0);
  const warnings = reports.reduce((sum, item) => sum + item.warnings.length, 0);
  ctx.print(
    `Validated ${reports.length} skill${reports.length === 1 ? '' : 's'}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`,
  );
  return errors > 0 ? 1 : 0;
}
