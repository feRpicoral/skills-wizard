import { join } from 'node:path';
import { styleText } from 'node:util';

import { unknownBlockIds, withRequirements } from '../blocks/compose.ts';
import type { Scope } from '../blocks/library.ts';
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
  readLocationManifest,
  resolveLocation,
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
        message: `${displayPath(entry.path, ctx.paths.home)} points to a missing target`,
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
        message: `${displayPath(shadow, home)} overrides the installed ${tool.label} instructions`,
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
        message: `${displayPath(path, home)} has ${lines} lines; ${tool.label} recommends keeping memory files under ${limits.lines}`,
      });
    }
    if (limits.bytes !== undefined && bytes > limits.bytes) {
      findings.push({
        level: 'warn',
        message: `${displayPath(path, home)} has ${bytes} bytes; ${tool.label} truncates rule files above ${limits.bytes}`,
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
          message: `${displayPath(extra, home)} is loaded in addition to ${displayPath(shared, home)}`,
        });
      }
    }
  }
  return findings;
}

export async function runDoctor(
  ctx: Context,
  options: DoctorOptions,
): Promise<number> {
  const location = await resolveLocation(
    ctx,
    options.scope,
    options.projectDir,
  );
  const manifest = await readLocationManifest(ctx, false, location);
  const home = ctx.paths.home;
  if (!manifest) {
    ctx.print(
      `No ${options.scope === 'global' ? 'system-wide' : 'project'} install recorded at ${displayPath(location.manifestPath, home)}.`,
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
  const { ids: blocks, added } = withRequirements(
    library,
    manifest.blocks.filter((id) => !unknown.includes(id)),
  );
  if (added.length > 0) {
    findings.push({
      level: 'warn',
      message: `Required blocks missing from the install: ${added.join(', ')}; agents-config sync will add them`,
    });
  }
  const plan = await buildPlan({
    scope: options.scope,
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
    const where = planPath(plan, action.path, home);
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
  findings.push(...(await symlinkFindings(ctx, manifest)));
  if (options.scope === 'global') {
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
