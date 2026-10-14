import { styleText } from 'node:util';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { displayPath } from '../install/describe.ts';
import {
  type Finding,
  globalFindings,
  type Level,
  manifestFindings,
  planFindings,
  symlinkFindings,
} from './doctor-checks.ts';
import { resolveDoctorSkills, skillFindings } from './doctor-skills.ts';
import {
  loadLibrary,
  readLocationManifest,
  reconcileManifest,
  resolveLocation,
} from './shared.ts';

const LEVEL_LABEL: Record<Level, string> = {
  error: styleText('red', 'error'),
  warn: styleText('yellow', 'warn '),
  note: styleText('dim', 'note '),
};

function printFindings(
  ctx: Context,
  findings: readonly Finding[],
): { problems: Finding[]; errors: Finding[] } {
  for (const finding of findings) {
    ctx.print(`${LEVEL_LABEL[finding.level]}  ${finding.message}`);
  }
  const problems = findings.filter((finding) => finding.level !== 'note');
  const errors = problems.filter((finding) => finding.level === 'error');
  return { problems, errors };
}

function printDoctorReport(ctx: Context, findings: readonly Finding[]): number {
  const { problems, errors } = printFindings(ctx, findings);
  ctx.print(
    problems.length === 0
      ? 'No problems found.'
      : `${problems.length} problem${problems.length === 1 ? '' : 's'} found.`,
  );
  return errors.length > 0 ? 1 : 0;
}

interface DoctorOptions {
  scope: Scope;
  projectDir?: string;
}

export async function runDoctor(
  ctx: Context,
  { scope, projectDir }: DoctorOptions,
): Promise<number> {
  const location = await resolveLocation({
    ctx,
    scope,
    ...(projectDir !== undefined ? { projectDir } : {}),
  });
  const manifest = await readLocationManifest({
    ctx,
    prompting: false,
    location,
  });
  const home = ctx.paths.home;
  if (!manifest) {
    ctx.print(
      `No ${scope === 'global' ? 'system-wide' : 'project'} install recorded at ${displayPath({ path: location.manifestPath, home })}.`,
    );
    if (scope === 'global') {
      const { problems } = printFindings(ctx, await skillFindings(ctx, null));
      if (problems.length > 0) {
        ctx.print(
          `${problems.length} problem${problems.length === 1 ? '' : 's'} found.`,
        );
      }
    }
    return 0;
  }

  const library = await loadLibrary(ctx);
  const reconciled = await reconcileManifest({
    manifest,
    library,
    location,
    lookupEnv: { home: ctx.paths.home, searchPath: ctx.searchPath },
  });
  const {
    skills,
    sources,
    findings: skillResolutionFindings,
  } = await resolveDoctorSkills(ctx, manifest);
  const { blocks, keepLocal, foundVariables, unresolvedVariables } = reconciled;
  // A placeholder keeps conflict checks running without a value, but the
  // rendered files would always differ, so out-of-date files are not reported
  // (skill folders and links still are).
  const variables = {
    ...foundVariables,
    ...Object.fromEntries(
      unresolvedVariables.map((name) => [name, `<${name}>`]),
    ),
  };
  const findings: Finding[] = [
    ...manifestFindings({
      ctx,
      location,
      reconciled,
      skillResolutionFindings,
    }),
    ...(await planFindings({
      ctx,
      location,
      manifest,
      library,
      blocks,
      variables,
      skills,
      skillSources: sources,
      keepLocal,
      reportOutdated: unresolvedVariables.length === 0,
    })),
    ...(await symlinkFindings(ctx, manifest)),
    ...(scope === 'global'
      ? [
          ...(await globalFindings(ctx, manifest)),
          ...(await skillFindings(ctx, manifest)),
        ]
      : []),
  ];

  return printDoctorReport(ctx, findings);
}
