import { styleText } from 'node:util';

import type { BlockLibrary } from '../blocks/library.ts';
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
import { orderedTools, type ToolDefinition } from '../tools/registry.ts';
import {
  type Location,
  type ReconciledManifest,
  setVariablesCommand,
} from './shared.ts';

export type Level = 'error' | 'warn' | 'note';

export interface Finding {
  level: Level;
  message: string;
}

const LEVEL_LABEL: Record<Level, string> = {
  error: styleText('red', 'error'),
  warn: styleText('yellow', 'warn '),
  note: styleText('dim', 'note '),
};

export async function symlinkFindings(
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

async function shadowFindings(
  ctx: Context,
  tools: readonly ToolDefinition[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  for (const tool of tools) {
    const shadow = tool.global.shadowedBy?.(ctx.paths);
    if (shadow && (await lstatIfExists(shadow))) {
      findings.push({
        level: 'warn',
        message: `${displayPath({ path: shadow, home })} overrides the installed ${tool.label} instructions`,
      });
    }
  }
  return findings;
}

interface LimitFindingsParams {
  ctx: Context;
  tools: readonly ToolDefinition[];
  owned: ReadonlySet<string>;
}

function lineCount(content: string): number {
  return content === '' ? 0 : content.replace(/\r?\n$/, '').split('\n').length;
}

async function limitFindings({
  ctx,
  tools,
  owned,
}: LimitFindingsParams): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const checked = new Set<string>();
  for (const tool of tools) {
    const path = tool.global.instructions(ctx.paths);
    const limits = tool.global.limits;
    if (!limits || !owned.has(path) || checked.has(path)) continue;
    checked.add(path);
    const content = await readTextIfExists(path);
    if (content === null) continue;
    const lines = lineCount(content);
    const bytes = Buffer.byteLength(content);
    if (limits.lines !== undefined && lines > limits.lines) {
      findings.push({
        level: 'note',
        message: `${displayPath({ path, home })} has ${lines} lines; ${tool.label} recommends keeping memory files under ${limits.lines}`,
      });
    }
    if (limits.bytes !== undefined && bytes > limits.bytes) {
      findings.push({
        level: 'warn',
        message: `${displayPath({ path, home })} has ${bytes} bytes; ${tool.label} truncates rule files above ${limits.bytes}`,
      });
    }
  }
  return findings;
}

async function extraFileFindings(
  ctx: Context,
  tools: readonly ToolDefinition[],
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const show = (path: string) => displayPath({ path, home });
  const reported = new Set<string>();
  for (const tool of tools) {
    const instructions = tool.global.instructions(ctx.paths);
    for (const extra of tool.global.alsoLoads?.(ctx.paths) ?? []) {
      if (reported.has(extra) || !(await lstatIfExists(extra))) continue;
      reported.add(extra);
      findings.push({
        level: 'warn',
        message: `${show(extra)} is loaded in addition to ${show(instructions)}`,
      });
    }
  }
  return findings;
}

export async function globalFindings(
  ctx: Context,
  manifest: Manifest,
): Promise<Finding[]> {
  const tools = orderedTools(manifest.tools);
  const owned = new Set(
    manifest.entries
      .filter((entry) => entry.kind === 'region')
      .map((entry) => entry.path),
  );
  return [
    ...(await shadowFindings(ctx, tools)),
    ...(await limitFindings({ ctx, tools, owned })),
    ...(await extraFileFindings(ctx, tools)),
  ];
}

export interface PlanFindingsParams {
  ctx: Context;
  location: Location;
  manifest: Manifest;
  library: BlockLibrary;
  blocks: string[];
  variables: Record<string, string>;
  keepLocal: boolean;
  reportOutdated: boolean;
}

export async function planFindings({
  ctx,
  location,
  manifest,
  library,
  blocks,
  variables,
  keepLocal,
  reportOutdated,
}: PlanFindingsParams): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const plan = await buildPlan({
    scope: location.scope,
    selection: {
      tools: manifest.tools,
      blocks,
      variables,
      linkCommand: manifest.options.linkCommand ?? false,
      keepLocal,
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
    } else if (reportOutdated && action.change.type !== 'none') {
      findings.push({
        level: 'warn',
        message: `${where} is out of date; run agents-config sync`,
      });
    }
  }
  return findings;
}

export interface ManifestFindingsParams {
  ctx: Context;
  location: Location;
  reconciled: ReconciledManifest;
}

export function manifestFindings({
  ctx,
  location,
  reconciled,
}: ManifestFindingsParams): Finding[] {
  const findings: Finding[] = [];
  const { scope } = location;
  const {
    unknownBlocks,
    outOfScopeBlocks,
    addedBlocks,
    leftGit,
    missingVariables,
    foundVariables,
    unresolvedVariables,
  } = reconciled;

  if (unknownBlocks.length > 0) {
    findings.push({
      level: 'warn',
      message: `Blocks no longer in the library: ${unknownBlocks.join(', ')}; agents-config sync will drop them`,
    });
  }
  if (outOfScopeBlocks.length > 0) {
    findings.push({
      level: 'warn',
      message: `Blocks no longer available for ${scope} scope: ${outOfScopeBlocks.join(', ')}; agents-config sync will drop them`,
    });
  }
  if (addedBlocks.length > 0) {
    findings.push({
      level: 'warn',
      message: `Required blocks missing from the install: ${addedBlocks.join(', ')}; agents-config sync will add them`,
    });
  }
  if (leftGit && location.project) {
    findings.push({
      level: 'warn',
      message: `${displayPath({ path: location.project.dir, home: ctx.paths.home })} is no longer in a git repository; agents-config sync will stop keeping its files local`,
    });
  }
  for (const name of missingVariables.filter(
    (name) => !unresolvedVariables.includes(name),
  )) {
    findings.push({
      level: 'warn',
      message: `The blocks now use ${name}, which has no recorded value; agents-config sync will record ${name}=${foundVariables[name] ?? ''}`,
    });
  }
  if (unresolvedVariables.length > 0) {
    findings.push({
      level: 'error',
      message: `The blocks now use variables with no recorded value: ${unresolvedVariables.join(', ')}; set them with ${setVariablesCommand({ ctx, location, names: unresolvedVariables })}`,
    });
  }
  return findings;
}

export function printDoctorReport(
  ctx: Context,
  findings: readonly Finding[],
): number {
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
