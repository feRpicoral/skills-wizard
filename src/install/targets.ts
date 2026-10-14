import { join, relative } from 'node:path';

import { composeGlobal, composeProject } from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import type { McpCatalog } from '../mcp/model.ts';
import type { McpJsonClient } from '../mcp/render.ts';
import type { PresetChoice, ProjectStyle } from '../project/presets.ts';
import type { SkillMode, SkillSource } from '../skills/install.ts';
import type { Manifest } from '../state/manifest.ts';
import {
  orderedTools,
  type ToolDefinition,
  type ToolId,
} from '../tools/registry.ts';
import {
  globalMcpTargets,
  mcpConfigPaths,
  type McpTargetsResult,
  projectMcpTargets,
  selectedMcpServers,
} from './mcp-targets.ts';
import {
  globalSkillTargets,
  projectSkillTargets,
  skillFolders,
} from './skill-targets.ts';

export { mcpConfigPaths, skillFolders };

export interface Selection {
  tools: ToolId[];
  blocks: string[];
  skills: string[];
  mcp?: string[];
  variables: Record<string, string>;
  linkCommand: boolean;
  keepLocal: boolean;
  skillMode: SkillMode;
  preset?: PresetChoice;
  style?: ProjectStyle;
}

export interface ProjectContext {
  dir: string;
  title: string;
  seed?: string;
  git?: { root: string; excludePath: string };
}

export interface Adoption {
  names: ReadonlySet<string>;
  backupDir: string;
}

export interface PlanInput {
  scope: Scope;
  selection: Selection;
  library: BlockLibrary;
  paths: Paths;
  repoRoot: string;
  previous: Manifest | null;
  manifestPath: string;
  project?: ProjectContext;
  skillSources?: ReadonlyMap<string, SkillSource>;
  mcpCatalog?: McpCatalog;
  adopt?: Adoption;
}

export interface RegionTarget {
  kind: 'region';
  path: string;
  body: string;
  preamble?: string;
  label: string;
}

export interface ExcludeRegionTarget {
  kind: 'exclude-region';
  path: string;
  id: string;
  paths: readonly string[];
  label: string;
}

export interface LineTarget {
  kind: 'line';
  path: string;
  line: string;
  satisfiedBy?: string;
  label: string;
}

export interface JsonArrayTarget {
  kind: 'json-array';
  path: string;
  key: string;
  values: readonly string[];
  mcpPermissionClient?: 'claude-code';
  label: string;
}

export interface SymlinkTarget {
  kind: 'symlink';
  path: string;
  target: string;
  label: string;
  skill?: string;
  backup?: string;
}

export interface SkillTarget {
  kind: 'skill';
  path: string;
  name: string;
  label: string;
  source: SkillSource | null;
  mode: SkillMode;
  backup?: string;
}

export interface McpJsonTarget {
  kind: 'mcp-json';
  path: string;
  servers: Readonly<Record<string, Record<string, unknown>>>;
  mcpClient?: McpJsonClient;
  label: string;
}

export interface McpTomlTarget {
  kind: 'mcp-toml';
  path: string;
  body: string;
  serverNames: readonly string[];
  label: string;
}

export type Target =
  | RegionTarget
  | ExcludeRegionTarget
  | LineTarget
  | JsonArrayTarget
  | SymlinkTarget
  | SkillTarget
  | McpJsonTarget
  | McpTomlTarget;

export type FileTarget = Exclude<Target, SymlinkTarget | SkillTarget>;

interface TargetKey {
  kind: string;
  path: string;
}

export function keyOf({ kind, path }: TargetKey): string {
  return `${kind}:${path}`;
}

function globalInstructionTargets(
  tools: readonly ToolDefinition[],
  body: string,
  paths: Paths,
): RegionTarget[] {
  const owners = new Map<string, string[]>();

  for (const tool of tools) {
    const path = tool.global.instructions(paths);
    owners.set(path, [...(owners.get(path) ?? []), tool.label]);
  }

  return [...owners.entries()].map(([path, labels]) => ({
    kind: 'region',
    path,
    body,
    label: `${labels.join(', ')} instructions`,
  }));
}

function globalSettingTargets(
  tools: readonly ToolDefinition[],
  paths: Paths,
): JsonArrayTarget[] {
  return tools.flatMap((tool) => {
    const setting = tool.global.settings?.(paths);
    if (!setting) return [];

    return [
      {
        kind: 'json-array',
        path: setting.file,
        key: setting.key,
        values: setting.values,
        label: `${tool.label} settings`,
      },
    ];
  });
}

function globalTargets(input: PlanInput): McpTargetsResult {
  const { selection, paths, library, repoRoot } = input;
  const tools = orderedTools(selection.tools);
  const targets: Target[] = [];
  const warnings: string[] = [];

  if (tools.length > 0) {
    const body = composeGlobal(library, selection.blocks, selection.variables);
    const mcp = globalMcpTargets({
      tools,
      servers: selectedMcpServers(input),
      paths,
    });

    warnings.push(...mcp.warnings);
    targets.push(
      ...globalInstructionTargets(tools, body, paths),
      ...globalSettingTargets(tools, paths),
      ...mcp.targets,
      ...globalSkillTargets(input),
    );
  }

  if (selection.linkCommand) {
    targets.push({
      kind: 'symlink',
      path: join(paths.localBin, 'agents-config'),
      target: join(repoRoot, 'src', 'cli.ts'),
      label: 'agents-config command',
    });
  }

  return { targets, warnings };
}

interface ProjectToolTargetsParams {
  tools: readonly ToolDefinition[];
  projectDir: string;
  instructionsPath: string;
}

function projectToolTargets({
  tools,
  projectDir,
  instructionsPath,
}: ProjectToolTargetsParams): Target[] {
  const targets: Target[] = [];

  for (const tool of tools) {
    const { importLine, settings } = tool.project;

    if (importLine) {
      targets.push({
        kind: 'line',
        path: join(projectDir, importLine.file),
        line: importLine.line,
        satisfiedBy: instructionsPath,
        label: `${tool.label} import`,
      });
    }

    if (settings) {
      targets.push({
        kind: 'json-array',
        path: join(projectDir, settings.file),
        key: settings.key,
        values: settings.values,
        label: `${tool.label} settings`,
      });
    }
  }

  return targets;
}

interface GitExcludeTargetParams {
  root: string;
  excludePath: string;
  projectDir: string;
  targets: readonly Target[];
  manifestPath: string;
}

function gitExcludeTarget({
  root,
  excludePath,
  projectDir,
  targets,
  manifestPath,
}: GitExcludeTargetParams): ExcludeRegionTarget {
  const uniquePaths = [
    ...new Set([...targets.map((target) => target.path), manifestPath]),
  ];
  const paths = uniquePaths.map((path) => relative(root, path));

  return {
    kind: 'exclude-region',
    path: excludePath,
    id: relative(root, projectDir) || '.',
    paths,
    label: 'git exclude entries',
  };
}

function projectTargets(input: PlanInput): McpTargetsResult {
  const { selection, library, project, manifestPath } = input;
  const tools = orderedTools(selection.tools);

  if (!project || tools.length === 0) return { targets: [], warnings: [] };

  const instructionsPath = join(project.dir, 'AGENTS.md');
  const mcp = projectMcpTargets({
    tools,
    servers: selectedMcpServers(input),
    projectDir: project.dir,
  });
  const targets: Target[] = [
    {
      kind: 'region',
      path: instructionsPath,
      body: composeProject(library, selection.blocks, selection.variables),
      preamble: project.seed ?? `# ${project.title}`,
      label: 'project instructions',
    },
    ...projectToolTargets({
      tools,
      projectDir: project.dir,
      instructionsPath,
    }),
    ...mcp.targets,
    ...projectSkillTargets(input, project),
  ];

  if (selection.keepLocal && project.git) {
    targets.push(
      gitExcludeTarget({
        root: project.git.root,
        excludePath: project.git.excludePath,
        projectDir: project.dir,
        targets,
        manifestPath,
      }),
    );
  }

  return { targets, warnings: mcp.warnings };
}

export function targetsForPlan(input: PlanInput): McpTargetsResult {
  return input.scope === 'global'
    ? globalTargets(input)
    : projectTargets(input);
}
