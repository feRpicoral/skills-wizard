import { dirname, join, relative } from 'node:path';

import type { SkillFolders } from '../state/manifest.ts';
import { orderedTools, TOOLS } from '../tools/registry.ts';
import { isInside } from './fs.ts';
import type {
  PlanInput,
  ProjectContext,
  SkillTarget,
  Target,
} from './targets.ts';

const PROJECT_SKILLS_DIR = join('.agents', 'skills');

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

export function globalSkillTargets(input: PlanInput): Target[] {
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

export function projectSkillTargets(
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
