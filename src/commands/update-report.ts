import { styleText } from 'node:util';

import type { Context } from '../context.ts';
import { lstatIfExists } from '../install/fs.ts';
import { diffSkillTrees, hasDiff, type SkillDiff } from '../skills/diff.ts';
import type { SkillSource } from '../skills/install.ts';
import { type RiskFlag, scanSkillRisks } from '../skills/risk.ts';
import type { Manifest, ManifestEntry } from '../state/manifest.ts';
import { notify } from './shared.ts';

export interface SkillChangeReport {
  name: string;
  diff: SkillDiff;
  risks: RiskFlag[];
}

const RISK_LABEL = styleText(['red', 'bold'], 'risk ');

type SkillCopyEntry = Extract<ManifestEntry, { kind: 'skill' }> & {
  install: { mode: 'copy'; hash: string; setup?: boolean };
};

function isSkillCopy(
  entry: ManifestEntry,
  name: string,
): entry is SkillCopyEntry {
  return (
    entry.kind === 'skill' &&
    entry.name === name &&
    entry.install.mode === 'copy'
  );
}

function isOutdatedCopy(entry: SkillCopyEntry, source: SkillSource): boolean {
  if (source.hash !== undefined && entry.install.hash !== source.hash) {
    return true;
  }
  return (
    entry.source.type === 'catalog' &&
    source.record.type === 'catalog' &&
    entry.source.commit !== source.record.commit
  );
}

function copySignature(entry: SkillCopyEntry): string {
  const commit = entry.source.type === 'catalog' ? entry.source.commit : '';
  return `${entry.install.hash}:${commit}`;
}

export async function findInstalledCopies(
  manifests: readonly Manifest[],
  name: string,
  source: SkillSource,
): Promise<string[]> {
  const outdated: string[] = [];
  const seen = new Set<string>();
  let fallback: string | null = null;
  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (!isSkillCopy(entry, name)) continue;
      if ((await lstatIfExists(entry.path))?.isDirectory() !== true) continue;
      if (isOutdatedCopy(entry, source)) {
        const key = copySignature(entry);
        if (!seen.has(key)) {
          seen.add(key);
          outdated.push(entry.path);
        }
      } else {
        fallback ??= entry.path;
      }
    }
  }
  if (outdated.length > 0) return outdated;
  return fallback === null ? [] : [fallback];
}

export async function findInstalledCopy(
  manifests: readonly Manifest[],
  name: string,
  source: SkillSource,
): Promise<string | null> {
  return (await findInstalledCopies(manifests, name, source))[0] ?? null;
}

export function formatDiffSummary(report: SkillChangeReport): string {
  const parts: string[] = [];
  if (report.diff.added.length > 0) {
    parts.push(`added ${report.diff.added.join(', ')}`);
  }
  if (report.diff.modified.length > 0) {
    parts.push(`modified ${report.diff.modified.join(', ')}`);
  }
  if (report.diff.removed.length > 0) {
    parts.push(`removed ${report.diff.removed.join(', ')}`);
  }
  return `${report.name}: ${parts.join('; ')}`;
}

export async function collectChangeReports(
  manifests: readonly Manifest[],
  names: readonly string[],
  sources: ReadonlyMap<string, SkillSource>,
): Promise<SkillChangeReport[]> {
  const reports: SkillChangeReport[] = [];
  for (const name of names) {
    const source = sources.get(name);
    if (!source) continue;
    for (const installed of await findInstalledCopies(
      manifests,
      name,
      source,
    )) {
      const diff = await diffSkillTrees({
        previousDir: installed,
        nextDir: source.dir,
      });
      if (!hasDiff(diff)) continue;
      const risks = await scanSkillRisks({
        previousDir: installed,
        nextDir: source.dir,
        precomputed: diff,
      });
      reports.push({ name, diff, risks });
    }
  }
  return reports;
}

export function printChangeReports(
  ctx: Context,
  prompting: boolean,
  reports: readonly SkillChangeReport[],
): void {
  for (const report of reports) {
    notify({ ctx, prompting, message: formatDiffSummary(report) });
    for (const risk of report.risks) {
      ctx.print(`${RISK_LABEL}  ${report.name} (${risk.file}): ${risk.detail}`);
    }
  }
}
