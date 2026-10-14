import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { BlockLibrary } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import { applyPlan } from '../install/apply.ts';
import {
  buildPlan,
  type Plan,
  type ProjectContext,
  type Selection,
} from '../install/plan.ts';
import {
  globalManifestPath,
  type Manifest,
  type ManifestEntry,
  projectManifestPath,
  readManifest,
  readProjectManifest,
} from '../state/manifest.ts';
import type { ToolId } from '../tools/registry.ts';

export const run = promisify(execFile);
export const BEGIN = '<!-- BEGIN:agents-config -->';
export const END = '<!-- END:agents-config -->';
export const REPO = '/repo';

export const library: BlockLibrary = {
  headers: { global: '# Rules' },
  groups: { core: 'Core' },
  blocks: [
    {
      id: 'core/identity',
      group: 'core',
      title: 'Identity',
      summary: 'Identity',
      scopes: ['global'],
      defaults: ['global'],
      variables: ['githubUsername'],
      requires: [],
      body: 'GitHub username: {{githubUsername}}',
    },
    {
      id: 'core/style',
      group: 'core',
      title: 'Style',
      summary: 'Style',
      scopes: ['global', 'project'],
      defaults: ['global', 'project'],
      variables: [],
      requires: [],
      body: '## Style\n\nBe direct.',
    },
  ],
};

export function selection(
  tools: ToolId[],
  overrides: Partial<Selection> = {},
): Selection {
  return {
    tools,
    blocks: ['core/identity', 'core/style'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    linkCommand: false,
    keepLocal: false,
    skillMode: 'copy',
    ...overrides,
  };
}

export async function installGlobal(
  paths: Paths,
  tools: ToolId[],
  overrides: Partial<Selection> = {},
): Promise<Plan> {
  const manifestPath = globalManifestPath(paths);
  const plan = await buildPlan({
    scope: 'global',
    selection: selection(tools, overrides),
    library,
    paths,
    repoRoot: REPO,
    previous: await readManifest(manifestPath),
    manifestPath,
  });

  await applyPlan(plan);
  return plan;
}

export interface InstallProjectParams {
  paths: Paths;
  project: ProjectContext;
  tools: ToolId[];
  overrides?: Partial<Selection>;
}

export async function installProject({
  paths,
  project,
  tools,
  overrides = {},
}: InstallProjectParams): Promise<Plan> {
  const manifestPath = projectManifestPath(project.dir);
  const stored = await readProjectManifest(manifestPath, {
    dir: project.dir,
    gitExcludePath: project.git?.excludePath,
  });

  const previous = stored?.manifest ?? null;
  const plan = await buildPlan({
    scope: 'project',
    selection: selection(tools, {
      blocks: ['core/style'],
      variables: {},
      ...overrides,
    }),
    library,
    paths,
    repoRoot: REPO,
    previous,
    manifestPath,
    project,
  });

  await applyPlan(plan);
  return plan;
}

export async function manifestOf(paths: Paths): Promise<Manifest | null> {
  return readManifest(globalManifestPath(paths));
}

export async function projectEntries(
  dir: string,
): Promise<ManifestEntry[] | null> {
  const stored = await readProjectManifest(projectManifestPath(dir), { dir });
  return stored?.manifest.entries ?? null;
}

export interface GitProjectParams {
  root: string;
  subdir?: string;
}

export async function gitProject({
  root,
  subdir = '',
}: GitProjectParams): Promise<ProjectContext> {
  await run('git', ['init', '-q'], { cwd: root });

  const realRoot = await realpath(root);
  const dir = join(realRoot, subdir);
  await mkdir(dir, { recursive: true });

  return {
    dir,
    title: 'app',
    git: {
      root: realRoot,
      excludePath: join(realRoot, '.git', 'info', 'exclude'),
    },
  };
}
