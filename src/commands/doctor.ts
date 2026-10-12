import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { styleText } from 'node:util';

import type { Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { displayPath } from '../install/describe.ts';
import { lstatIfExists, readTextIfExists } from '../install/fs.ts';
import { buildPlan } from '../install/plan.ts';
import { type Manifest, readManifest } from '../state/manifest.ts';
import { orderedTools, type ToolId } from '../tools/registry.ts';
import { knownBlocks, loadLibrary, resolveLocation } from './shared.ts';

export interface DoctorOptions {
  scope: Scope;
  projectDir?: string;
}

interface Finding {
  level: 'warn' | 'error';
  message: string;
}

const SHARED_GEMINI_TOOLS: readonly ToolId[] = [
  'antigravity',
  'antigravity-cli',
  'gemini-cli',
];

async function brokenSymlinks(manifest: Manifest): Promise<string[]> {
  const broken: string[] = [];
  for (const entry of manifest.entries) {
    if (entry.kind !== 'symlink') continue;
    const link = await lstatIfExists(entry.path);
    if (!link) continue;
    const target = await stat(entry.path).catch(() => null);
    if (!target) broken.push(entry.path);
  }
  return broken;
}

async function globalChecks(
  ctx: Context,
  manifest: Manifest,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;

  for (const tool of orderedTools(manifest.tools)) {
    const shadow = tool.global.shadowedBy?.(ctx.paths);
    if (shadow && (await lstatIfExists(shadow))) {
      findings.push({
        level: 'warn',
        message: `${displayPath(shadow, home)} overrides the installed ${tool.label} instructions`,
      });
    }

    const limits = tool.global.limits;
    if (!limits) continue;
    const path = tool.global.instructions(ctx.paths);
    const content = await readTextIfExists(path);
    if (content === null) continue;
    const lines = content.split('\n').length - 1;
    const bytes = Buffer.byteLength(content);
    if (limits.lines !== undefined && lines > limits.lines) {
      findings.push({
        level: 'warn',
        message: `${displayPath(path, home)} has ${lines} lines; ${tool.label} warns above ${limits.lines}`,
      });
    }
    if (limits.bytes !== undefined && bytes > limits.bytes) {
      findings.push({
        level: 'warn',
        message: `${displayPath(path, home)} has ${bytes} bytes; ${tool.label} truncates above ${limits.bytes}`,
      });
    }
  }

  if (manifest.tools.some((id) => SHARED_GEMINI_TOOLS.includes(id))) {
    const extras = [
      join(ctx.paths.geminiHome, 'GEMINI.md'),
      join(ctx.paths.geminiHome, 'config', 'AGENTS.md'),
      join(ctx.paths.geminiHome, 'config', 'GEMINI.md'),
    ];
    for (const extra of extras) {
      if (await lstatIfExists(extra)) {
        findings.push({
          level: 'warn',
          message: `${displayPath(extra, home)} is loaded in addition to ~/.gemini/AGENTS.md`,
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
  const manifest = await readManifest(location.manifestPath, location.baseDir);
  const home = ctx.paths.home;
  if (!manifest) {
    ctx.print(
      `No ${options.scope === 'global' ? 'system-wide' : 'project'} install recorded at ${displayPath(location.manifestPath, home)}.`,
    );
    return 0;
  }

  const library = await loadLibrary(ctx);
  const { blocks, dropped } = knownBlocks(library, manifest);
  const findings: Finding[] = dropped.map((id) => ({
    level: 'warn',
    message: `Block ${id} no longer exists; agents-config sync will drop it`,
  }));

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
    now: ctx.now(),
    ...(location.projectDir ? { projectDir: location.projectDir } : {}),
    ...(location.projectTitle ? { projectTitle: location.projectTitle } : {}),
    ...(location.gitExcludePath
      ? { gitExcludePath: location.gitExcludePath }
      : {}),
  });

  for (const action of plan.actions) {
    if (action.status === 'conflict') {
      findings.push({
        level: 'error',
        message: `${displayPath(action.path, home)}: ${action.reason ?? 'conflict'}`,
      });
    } else if (action.change.type !== 'none') {
      findings.push({
        level: 'warn',
        message: `${displayPath(action.path, home)} is out of date; run agents-config sync`,
      });
    }
  }
  for (const path of await brokenSymlinks(manifest)) {
    findings.push({
      level: 'error',
      message: `${displayPath(path, home)} points to a missing target`,
    });
  }
  if (options.scope === 'global') {
    findings.push(...(await globalChecks(ctx, manifest)));
  }

  for (const finding of findings) {
    const label =
      finding.level === 'error'
        ? styleText('red', 'error')
        : styleText('yellow', 'warn ');
    ctx.print(`${label}  ${finding.message}`);
  }
  const errors = findings.filter((finding) => finding.level === 'error').length;
  ctx.print(
    findings.length === 0
      ? 'No problems found.'
      : `${findings.length} problem${findings.length === 1 ? '' : 's'} found.`,
  );
  return errors > 0 ? 1 : 0;
}
