import { styleText } from 'node:util';

import {
  outOfScopeBlockIds,
  requiredVariables,
  selectBlocks,
  unknownBlockIds,
  withRequirements,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import { lookupVariables } from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import { displayPath, planPath } from '../install/describe.ts';
import {
  lstatIfExists,
  readSymlink,
  readTextIfExists,
  statIfExists,
} from '../install/fs.ts';
import { buildPlan, type PlannedAction } from '../install/plan.ts';
import {
  allServerSecrets,
  type McpCatalog,
  outOfScopeMcpServerNames,
  requiredServerSecrets,
  selectMcpServers,
  unknownMcpServerNames,
} from '../mcp/model.ts';
import { isPresetId, type PresetId } from '../project/presets.ts';
import { scanInstalledSkills } from '../skills/collisions.ts';
import {
  DEFAULT_SKILL_MODE,
  resolveSkillSources,
  type SkillSource,
} from '../skills/install.ts';
import { loadSkillLibrary, unknownSkillNames } from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import { orderedTools } from '../tools/registry.ts';
import {
  loadLibrary,
  loadMcpServers,
  type Location,
  readLocationManifest,
  replacementSkillHint,
  resolveLocation,
  setVariablesCommand,
  sourceCache,
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

  const reported = new Set<string>();
  for (const tool of orderedTools(manifest.tools)) {
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

interface PlanFindingsParams {
  ctx: Context;
  location: Location;
  manifest: Manifest;
  library: BlockLibrary;
  blocks: string[];
  variables: Record<string, string>;
  skills: string[];
  skillSources: ReadonlyMap<string, SkillSource>;
  mcp: string[];
  mcpCatalog: McpCatalog;
  keepLocal: boolean;
  preset: PresetId | undefined;
  reportOutdated: boolean;
}

function rendersBlocks(action: PlannedAction): boolean {
  const kind = (action.entry ?? action.previous)?.kind;
  return (
    kind !== 'skill' &&
    kind !== 'symlink' &&
    kind !== 'mcp-json' &&
    kind !== 'mcp-toml'
  );
}

async function planFindings({
  ctx,
  location,
  manifest,
  library,
  blocks,
  variables,
  skills,
  skillSources,
  mcp,
  mcpCatalog,
  keepLocal,
  preset,
  reportOutdated,
}: PlanFindingsParams): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const plan = await buildPlan({
    scope: location.scope,
    selection: {
      tools: manifest.tools,
      blocks,
      skills,
      mcp,
      variables,
      linkCommand: manifest.options.linkCommand ?? false,
      keepLocal,
      skillMode: manifest.options.skillMode ?? DEFAULT_SKILL_MODE,
      ...(preset !== undefined ? { preset } : {}),
      ...(manifest.options.style !== undefined
        ? { style: manifest.options.style }
        : {}),
    },
    library,
    paths: ctx.paths,
    repoRoot: ctx.repoRoot,
    previous: manifest,
    manifestPath: location.manifestPath,
    ...(location.project ? { project: location.project } : {}),
    skillSources,
    mcpCatalog,
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
    } else if (
      action.change.type !== 'none' &&
      (reportOutdated || !rendersBlocks(action))
    ) {
      findings.push({
        level: 'warn',
        message: `${where} is out of date; run agents-config sync`,
      });
    }
  }
  for (const warning of plan.warnings ?? []) {
    findings.push({ level: 'warn', message: warning });
  }
  return findings;
}

async function skillFindings(
  ctx: Context,
  manifest: Manifest | null,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const home = ctx.paths.home;
  const scan = await scanInstalledSkills(ctx.paths, manifest);
  for (const collision of scan.collisions) {
    const locations = collision.paths
      .map((path) => displayPath({ path, home }))
      .join(', ');
    findings.push({
      level: 'warn',
      message: `Skill "${collision.name}" is declared in multiple locations: ${locations}`,
    });
  }
  if (scan.unmanaged.length > 0) {
    const list = scan.unmanaged
      .map(
        (skill) => `${skill.name} (${displayPath({ path: skill.path, home })})`,
      )
      .join(', ');
    findings.push({
      level: 'note',
      message: `Unmanaged skills: ${list}`,
    });
  }
  return findings;
}

interface McpFindingsParams {
  ctx: Context;
  scope: Scope;
  manifest: Manifest;
  mcpCatalog: McpCatalog;
  mcp: readonly string[];
}

function mcpFindings({
  ctx,
  scope,
  manifest,
  mcpCatalog,
  mcp,
}: McpFindingsParams): Finding[] {
  if (mcp.length === 0 || manifest.tools.length === 0) return [];
  const findings: Finding[] = [];
  const servers = selectMcpServers({
    catalog: mcpCatalog,
    names: mcp,
    scope,
  });

  for (const server of servers) {
    const missingSecrets = requiredServerSecrets(server).filter(
      (secret) => !(ctx.hasEnvVar?.(secret) ?? false),
    );
    if (missingSecrets.length > 0) {
      findings.push({
        level: 'warn',
        message: `MCP server "${server.name}" requires unset environment variable${missingSecrets.length === 1 ? '' : 's'}: ${missingSecrets.join(', ')}`,
      });
    }
  }

  if (manifest.tools.includes('antigravity')) {
    const stdioSecretServers = servers.filter(
      (server) =>
        server.transport === 'stdio' && allServerSecrets(server).length > 0,
    );
    if (stdioSecretServers.length > 0) {
      const names = stdioSecretServers.map((server) => server.name).join(', ');
      findings.push({
        level: 'note',
        message: `Antigravity stdio MCP server${stdioSecretServers.length === 1 ? '' : 's'} (${names}) read secret environment variables from the process environment; launching Antigravity from the macOS Dock may not inherit shell variables unless launched from a terminal or configured via launchctl`,
      });
    }
  }

  if (scope === 'project') {
    if (manifest.tools.includes('claude-code')) {
      findings.push({
        level: 'note',
        message:
          'Claude Code requires interactive project approval before loading MCP servers from .mcp.json',
      });
    }
    if (manifest.tools.includes('codex')) {
      findings.push({
        level: 'note',
        message:
          'Codex loads project .codex/config.toml MCP servers only after the project is marked trusted',
      });
    }
    if (manifest.tools.includes('gemini-cli')) {
      findings.push({
        level: 'note',
        message:
          'Gemini CLI loads project .gemini/settings.json MCP servers only in trusted folders',
      });
    }
  }

  if (manifest.tools.includes('gemini-cli')) {
    const totalTools = servers.reduce(
      (sum, server) => sum + (server.estimatedTools ?? 0),
      0,
    );
    findings.push({
      level: 'note',
      message: `Gemini CLI loads all MCP tool schemas into context up front (~${totalTools} estimated tool${totalTools === 1 ? '' : 's'} across ${servers.length} server${servers.length === 1 ? '' : 's'})`,
    });
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
    if (scope === 'global') {
      const findings = await skillFindings(ctx, null);
      for (const finding of findings) {
        ctx.print(`${LEVEL_LABEL[finding.level]}  ${finding.message}`);
      }
      const problems = findings.filter((finding) => finding.level !== 'note');
      if (problems.length > 0) {
        ctx.print(
          `${problems.length} problem${problems.length === 1 ? '' : 's'} found.`,
        );
      }
    }
    return 0;
  }

  const library = await loadLibrary(ctx);
  const findings: Finding[] = [];
  const rawPreset = manifest.options.preset;
  const preset =
    rawPreset !== undefined && isPresetId(rawPreset) ? rawPreset : undefined;
  if (rawPreset !== undefined && preset === undefined) {
    findings.push({
      level: 'warn',
      message: `Preset "${rawPreset}" is no longer recognized; agents-config sync will drop it`,
    });
  }
  const unknown = unknownBlockIds(library, manifest.blocks);
  if (unknown.length > 0) {
    findings.push({
      level: 'warn',
      message: `Blocks no longer in the library: ${unknown.join(', ')}; agents-config sync will drop them${replacementSkillHint(unknown)}`,
    });
  }
  const outOfScope = outOfScopeBlockIds(library, manifest.blocks, scope);
  if (outOfScope.length > 0) {
    findings.push({
      level: 'warn',
      message: `Blocks no longer available for ${scope} scope: ${outOfScope.join(', ')}; agents-config sync will drop them${replacementSkillHint(outOfScope)}`,
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
  const skillLibrary = await loadSkillLibrary(ctx.repoRoot);
  const unknownSkills = unknownSkillNames(skillLibrary, manifest.skills);
  if (unknownSkills.length > 0) {
    findings.push({
      level: 'warn',
      message: `Skills no longer in catalog.yaml or skills/: ${unknownSkills.join(', ')}; agents-config sync will remove them`,
    });
  }
  const skills = manifest.skills.filter(
    (name) => !unknownSkills.includes(name),
  );
  const resolution = await resolveSkillSources({
    library: skillLibrary,
    names: skills,
    cache: sourceCache(ctx),
    fetch: false,
  });
  for (const [name, problem] of resolution.problems) {
    findings.push({
      level: 'note',
      message: `Skipped checking the ${name} skill: ${problem}`,
    });
  }
  const mcpCatalog = await loadMcpServers(ctx);
  const unknownMcp = unknownMcpServerNames(mcpCatalog, manifest.mcp);
  if (unknownMcp.length > 0) {
    findings.push({
      level: 'warn',
      message: `MCP servers no longer in mcp/servers.yaml: ${unknownMcp.join(', ')}; agents-config sync will remove them`,
    });
  }
  const outOfScopeMcp = outOfScopeMcpServerNames({
    catalog: mcpCatalog,
    names: manifest.mcp,
    scope,
  });
  if (outOfScopeMcp.length > 0) {
    findings.push({
      level: 'warn',
      message: `MCP servers no longer available for ${scope} scope: ${outOfScopeMcp.join(', ')}; agents-config sync will remove them`,
    });
  }
  const mcp = manifest.mcp.filter(
    (name) => !unknownMcp.includes(name) && !outOfScopeMcp.includes(name),
  );
  const recordedLocal = manifest.options.keepLocal ?? false;
  const keepLocal = recordedLocal && location.project?.git !== undefined;
  if (location.project && recordedLocal && !keepLocal) {
    findings.push({
      level: 'warn',
      message: `${displayPath({ path: location.project.dir, home })} is no longer in a git repository; agents-config sync will stop keeping its files local`,
    });
  }
  const needed = requiredVariables(selectBlocks(library, blocks, scope));
  const missing = needed.filter((name) => !manifest.variables[name]?.trim());
  const found = await lookupVariables(missing, manifest.variables);
  const unresolved = missing.filter((name) => !found[name]?.trim());
  for (const name of missing.filter((name) => !unresolved.includes(name))) {
    findings.push({
      level: 'warn',
      message: `The blocks now use ${name}, which has no recorded value; agents-config sync will record ${name}=${found[name] ?? ''}`,
    });
  }
  if (unresolved.length > 0) {
    findings.push({
      level: 'error',
      message: `The blocks now use variables with no recorded value: ${unresolved.join(', ')}; set them with ${setVariablesCommand({ ctx, location, names: unresolved })}`,
    });
  }
  // A placeholder keeps conflict checks running without a value, but the
  // rendered files would always differ, so out-of-date files are not reported
  // (skill folders and links still are).
  const variables = {
    ...found,
    ...Object.fromEntries(unresolved.map((name) => [name, `<${name}>`])),
  };
  findings.push(
    ...(await planFindings({
      ctx,
      location,
      manifest,
      library,
      blocks,
      variables,
      skills,
      skillSources: resolution.sources,
      mcp,
      mcpCatalog,
      keepLocal,
      preset,
      reportOutdated: unresolved.length === 0,
    })),
  );
  findings.push(...mcpFindings({ ctx, scope, manifest, mcpCatalog, mcp }));
  findings.push(...(await symlinkFindings(ctx, manifest)));
  if (scope === 'global') {
    findings.push(
      ...(await globalFindings(ctx, manifest)),
      ...(await skillFindings(ctx, manifest)),
    );
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
