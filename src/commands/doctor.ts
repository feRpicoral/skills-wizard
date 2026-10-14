import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { displayPath } from '../install/describe.ts';
import {
  type Finding,
  globalFindings,
  manifestFindings,
  planFindings,
  printDoctorReport,
  printFindings,
  resolveDoctorSkills,
  skillFindings,
  symlinkFindings,
} from './doctor-checks.ts';
import {
  loadLibrary,
  readLocationManifest,
  reconcileManifest,
  resolveLocation,
} from './shared.ts';

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
