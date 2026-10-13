import { join } from 'node:path';
import { styleText } from 'node:util';

import {
  outOfScopeBlockIds,
  requiredVariables,
  selectBlocks,
  unknownBlockIds,
  withRequirements,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { displayPath, planPath } from '../install/describe.ts';
import {
  lstatIfExists,
  readSymlink,
  readTextIfExists,
  statIfExists,
} from '../install/fs.ts';
import { buildPlan } from '../install/plan.ts';
import type { Manifest } from '../state/manifest.ts';
import { orderedTools, TOOLS } from '../tools/registry.ts';
import {
  loadLibrary,
  type Location,
  readLocationManifest,
  resolveLocation,
  setVariablesCommand,
} from './shared.ts';

interface DoctorOptions {
  scope: Scope;
  projectDir?: string;
}

type Level = 'error' | 'warn' | 'note';

interface Finding {
  level: Level;
  message: string;
}

const LEVEL_LABEL: Record<Level, string> = {
  error: styleText('red', 'error'),
  warn: styleText('yellow', 'warn '),
  note: styleText('dim', 'note '),
};

async function symlinkFindings(
  ctx: Context,
  manifest: Manifest,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== 'symlink') continue;
    const current = await readSymlink(entry.path);
    if (current !== entry.target) continue;
    if (!(await statIfExists(entry.path))) {
      findings.push({
        level: 'error',
        message: `${displayPath({ path: entry.path, home: ctx.paths.home })} points to a missing target`,
      });
    }
  }
  return findings;
}

async function globalFindings(
  ctx: Context,
  manifest: Manifest,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const show = (path: string) => displayPath({ path, home });
  const owned = new Set(
    manifest.entries
      .filter((entry) => entry.kind === 'region')
      .map((entry) => entry.path),
  );
  const checked = new Set<string>();

  for (const tool of orderedTools(manifest.tools)) {
    const shadow = tool.global.shadowedBy?.(ctx.paths);
    if (shadow && (await lstatIfExists(shadow))) {
      findings.push({
        level: 'warn',
        message: `${show(shadow)} overrides the installed ${tool.label} instructions`,
      });
    }

    const path = tool.global.instructions(ctx.paths);
    const limits = tool.global.limits;
    if (!limits || !owned.has(path) || checked.has(path)) continue;
    checked.add(path);
    const content = await readTextIfExists(path);
    if (content === null) continue;
    const lines = content.split('\n').length - 1;
    const bytes = Buffer.byteLength(content);
    if (limits.lines !== undefined && lines > limits.lines) {
      findings.push({
        level: 'note',
        message: `${show(path)} has ${lines} lines; ${tool.label} recommends keeping memory files under ${limits.lines}`,
      });
    }
    if (limits.bytes !== undefined && bytes > limits.bytes) {
      findings.push({
        level: 'warn',
        message: `${show(path)} has ${bytes} bytes; ${tool.label} truncates rule files above ${limits.bytes}`,
      });
    }
  }

  const shared = join(ctx.paths.geminiHome, 'AGENTS.md');
  const usesShared = manifest.tools.some(
    (id) => TOOLS[id].global.instructions(ctx.paths) === shared,
  );
  if (usesShared) {
    const extras = [
      join(ctx.paths.geminiHome, 'GEMINI.md'),
      join(ctx.paths.geminiHome, 'config', 'AGENTS.md'),
      join(ctx.paths.geminiHome, 'config', 'GEMINI.md'),
    ];
    for (const extra of extras) {
      if (await lstatIfExists(extra)) {
        findings.push({
          level: 'warn',
          message: `${show(extra)} is loaded in addition to ${show(shared)}`,
        });
      }
    }
  }
  return findings;
}

interface PlanFindingsParams {
  ctx: Context;
  location: Location;
  manifest: Manifest;
  library: BlockLibrary;
  blocks: string[];
}

async function planFindings({
  ctx,
  location,
  manifest,
  library,
  blocks,
}: PlanFindingsParams): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const plan = await buildPlan({
    scope: location.scope,
    selection: {
      tools: manifest.tools,
      blocks,
      variables: manifest.variables,
      linkCommand: manifest.options.linkCommand ?? false,
      keepLocal: manifest.options.keepLocal ?? false,
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous: manifest,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
  });

  for (const action of plan.actions) {
    const where = planPath({ plan, path: action.path, home });
    if (action.status === 'conflict') {
      findings.push({
        level:
          action.previous && action.previous.kind !== 'symlink'
            ? 'error'
            : 'warn',
        message: `${where}: ${action.reason ?? 'conflict'}`,
      });
    } else if (action.change.type !== 'none') {
      findings.push({
        level: 'warn',
        message: `${where} is out of date; run agents-config sync`,
      });
    }
  }
  return findings;
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
  const manifest = await readLocationManifest(ctx, false, location);
  const home = ctx.paths.home;
  if (!manifest) {
    ctx.print(
      `No ${scope === 'global' ? 'system-wide' : 'project'} install recorded at ${displayPath({ path: location.manifestPath, home })}.`,
    );
    return 0;
  }

  const library = await loadLibrary(ctx);
  const findings: Finding[] = [];
  const unknown = unknownBlockIds(library, manifest.blocks);
  if (unknown.length > 0) {
    findings.push({
      level: 'warn',
      message: `Blocks no longer in the library: ${unknown.join(', ')}; agents-config sync will drop them`,
    });
  }
  const outOfScope = outOfScopeBlockIds(library, manifest.blocks, scope);
  if (outOfScope.length > 0) {
    findings.push({
      level: 'warn',
      message: `Blocks no longer available for ${scope} scope: ${outOfScope.join(', ')}; agents-config sync will drop them`,
    });
  }
  const { ids: blocks, added } = withRequirements(
    library,
    manifest.blocks.filter(
      (id) => !unknown.includes(id) && !outOfScope.includes(id),
    ),
  );
  if (added.length > 0) {
    findings.push({
      level: 'warn',
      message: `Required blocks missing from the install: ${added.join(', ')}; agents-config sync will add them`,
    });
  }
  const needed = requiredVariables(selectBlocks(library, blocks, scope));
  const missing = needed.filter((name) => !manifest.variables[name]?.trim());
  if (missing.length > 0) {
    findings.push({
      level: 'error',
      message: `The blocks now use variables with no recorded value: ${missing.join(', ')}; set them with ${setVariablesCommand({ ctx, location, names: missing })}`,
    });
  } else {
    findings.push(
      ...(await planFindings({ ctx, location, manifest, library, blocks })),
    );
  }
  findings.push(...(await symlinkFindings(ctx, manifest)));
  if (scope === 'global') {
    findings.push(...(await globalFindings(ctx, manifest)));
  }

  for (const finding of findings) {
    ctx.print(`${LEVEL_LABEL[finding.level]}  ${finding.message}`);
  }
  const problems = findings.filter((finding) => finding.level !== 'note');
  const errors = problems.filter((finding) => finding.level === 'error');
  ctx.print(
    problems.length === 0
      ? 'No problems found.'
      : `${problems.length} problem${problems.length === 1 ? '' : 's'} found.`,
  );
  return errors.length > 0 ? 1 : 0;
}
