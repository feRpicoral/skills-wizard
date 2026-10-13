import { dirname, join, relative } from 'node:path';

import { composeGlobal, composeProject } from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import type { PresetId, ProjectStyle } from '../project/presets.ts';
import type { SkillMode, SkillSource } from '../skills/install.ts';
import type { Manifest, SkillFolders } from '../state/manifest.ts';
import {
  orderedTools,
  type ToolDefinition,
  type ToolId,
  TOOLS,
} from '../tools/registry.ts';
import { isInside } from './fs.ts';

export interface Selection {
  tools: ToolId[];
  blocks: string[];
  skills: string[];
  variables: Record<string, string>;
  linkCommand: boolean;
  keepLocal: boolean;
  skillMode: SkillMode;
  preset?: PresetId;
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
  body: string;
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

export type Target =
  | RegionTarget
  | ExcludeRegionTarget
  | LineTarget
  | JsonArrayTarget
  | SymlinkTarget
  | SkillTarget;

export type FileTarget = Exclude<Target, SymlinkTarget | SkillTarget>;

const PROJECT_SKILLS_DIR = join('.agents', 'skills');

interface TargetKey {
  kind: string;
  path: string;
}

export function keyOf({ kind, path }: TargetKey): string {
  return `${kind}:${path}`;
}

interface SkillPathParams {
  input: PlanInput;
  name: string;
  path: string;
}

function backupPath({ input, name, path }: SkillPathParams): {
  backup?: string;
} {
  if (!input.adopt?.names.has(name)) return {};
  const { home } = input.paths;
  const inside = isInside({ dir: home, path })
    ? relative(home, path)
    : path.slice(1);
  return { backup: join(input.adopt.backupDir, inside) };
}

function hasSkillEntry(input: PlanInput, path: string): boolean {
  return (input.previous?.entries ?? []).some(
    (entry) => entry.kind === 'skill' && entry.path === path,
  );
}

function skillTarget({
  input,
  name,
  path,
}: SkillPathParams): SkillTarget | null {
  const source = input.skillSources?.get(name) ?? null;
  if (!source && !hasSkillEntry(input, path)) return null;
  const linked =
    input.scope === 'global' &&
    input.selection.skillMode === 'link' &&
    source?.linkable === true;
  return {
    kind: 'skill',
    path,
    name,
    label: `${name} skill`,
    source,
    mode: linked ? 'link' : 'copy',
    ...backupPath({ input, name, path }),
  };
}

function globalSkillTargets(input: PlanInput): Target[] {
  const linkDirs = new Map<string, string[]>();
  for (const tool of orderedTools(input.selection.tools)) {
    const dir = tool.global.skills?.(input.paths);
    if (dir) linkDirs.set(dir, [...(linkDirs.get(dir) ?? []), tool.label]);
  }
  return input.selection.skills.flatMap((name): Target[] => {
    const path = join(input.paths.skillsDir, name);
    const skill = skillTarget({ input, name, path });
    if (!skill) return [];
    const links = [...linkDirs].map(([dir, labels]): Target => {
      const link = join(dir, name);
      return {
        kind: 'symlink',
        path: link,
        target: path,
        label: `${labels.join(', ')} link to ${name}`,
        skill: name,
        ...backupPath({ input, name, path: link }),
      };
    });
    return [skill, ...links];
  });
}

function projectSkillTargets(
  input: PlanInput,
  project: ProjectContext,
): Target[] {
  const linkDirs = orderedTools(input.selection.tools).flatMap((tool) =>
    tool.project.skills
      ? [{ dir: join(project.dir, tool.project.skills), label: tool.label }]
      : [],
  );
  return input.selection.skills.flatMap((name): Target[] => {
    const path = join(project.dir, PROJECT_SKILLS_DIR, name);
    const skill = skillTarget({ input, name, path });
    if (!skill) return [];
    const links = linkDirs.map(({ dir, label }): Target => {
      const link = join(dir, name);
      return {
        kind: 'symlink',
        path: link,
        target: relative(dirname(link), path),
        label: `${label} link to ${name}`,
        skill: name,
      };
    });
    return [skill, ...links];
  });
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

function globalTargets(input: PlanInput): Target[] {
  const { selection, paths, library, repoRoot } = input;
  const tools = orderedTools(selection.tools);
  const targets: Target[] = [];

  if (tools.length > 0) {
    const body = composeGlobal(library, selection.blocks, selection.variables);
    targets.push(
      ...globalInstructionTargets(tools, body, paths),
      ...globalSettingTargets(tools, paths),
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
  return targets;
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

function gitignorePattern(path: string): string {
  const escaped = path
    .replace(/[[\]*?\\]/g, '\\$&')
    .replace(/ +$/, (spaces) => '\\ '.repeat(spaces.length));
  return `/${escaped}`;
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
  const patterns = [...targets.map((target) => target.path), manifestPath]
    .map((path) => gitignorePattern(relative(root, path)))
    .join('\n');
  return {
    kind: 'exclude-region',
    path: excludePath,
    id: relative(root, projectDir) || '.',
    body: patterns,
    label: 'git exclude entries',
  };
}

function projectTargets(input: PlanInput): Target[] {
  const { selection, library, project, manifestPath } = input;
  const tools = orderedTools(selection.tools);
  if (!project || tools.length === 0) return [];

  const instructionsPath = join(project.dir, 'AGENTS.md');
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
  return targets;
}

export function targetsForPlan({ scope, ...rest }: PlanInput): Target[] {
  const input: PlanInput = { scope, ...rest };
  return scope === 'global' ? globalTargets(input) : projectTargets(input);
}

export function skillFolders({
  scope,
  paths,
  project,
}: Pick<PlanInput, 'scope' | 'paths' | 'project'>): SkillFolders | null {
  const tools = Object.values(TOOLS);
  if (scope === 'global') {
    return {
      copies: paths.skillsDir,
      links: tools.flatMap((tool) => tool.global.skills?.(paths) ?? []),
    };
  }
  if (!project) return null;
  return {
    copies: join(project.dir, PROJECT_SKILLS_DIR),
    links: tools.flatMap((tool) =>
      tool.project.skills ? [join(project.dir, tool.project.skills)] : [],
    ),
  };
}
