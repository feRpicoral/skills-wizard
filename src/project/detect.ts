import { basename, join } from 'node:path';

import {
  isInside,
  readDirIfExists,
  readTextIfExists,
  realLocation,
  statIfExists,
} from '../install/fs.ts';
import type { PresetId } from './presets.ts';

export type DetectedPackageManager = 'yarn' | 'pnpm' | 'npm' | 'uv';

export interface WorkspacePackageInfo {
  relativePath: string;
  name: string;
  description?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

export interface ProjectDetection {
  name: string;
  description?: string;
  preset?: PresetId;
  packageManager?: DetectedPackageManager;
  nvmrc?: string;
  scripts: Record<string, string>;
  hasNx: boolean;
  hasPyproject: boolean;
  workspaces: WorkspacePackageInfo[];
  detectedBlocks: string[];
  detectedSkills: string[];
}

interface BoundaryPathParams {
  projectDir: string;
  relativePath: string;
}

interface ParsedPackageJson {
  name?: string;
  description?: string;
  packageManager?: string;
  scripts: Record<string, string>;
  dependencies: string[];
  workspaces: string[];
}

interface ParsedPyproject {
  name?: string;
  description?: string;
}

async function resolveProjectFile({
  projectDir,
  relativePath,
}: BoundaryPathParams): Promise<string | null> {
  const root = (await realLocation(projectDir)) ?? projectDir;
  const location = await realLocation(join(root, relativePath));
  if (location === null || !isInside({ dir: root, path: location })) {
    return null;
  }
  if (!(await statIfExists(location))?.isFile()) return null;
  return location;
}

export async function readProjectFile({
  projectDir,
  relativePath,
}: BoundaryPathParams): Promise<string | null> {
  const location = await resolveProjectFile({ projectDir, relativePath });
  if (location === null) return null;
  return readTextIfExists(location);
}

async function hasProjectFile({
  projectDir,
  relativePath,
}: BoundaryPathParams): Promise<boolean> {
  return (await resolveProjectFile({ projectDir, relativePath })) !== null;
}

function stringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}

function dependencyNames(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.keys(raw);
}

function parseWorkspacesField(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string');
  }
  if (raw && typeof raw === 'object' && 'packages' in raw) {
    const packages = (raw as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter(
        (item): item is string => typeof item === 'string',
      );
    }
  }
  return [];
}

function parsePackageJson(source: string): ParsedPackageJson | null {
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const name =
      typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim()
        : undefined;
    const description =
      typeof parsed.description === 'string' && parsed.description.trim()
        ? parsed.description.trim()
        : undefined;
    const packageManager =
      typeof parsed.packageManager === 'string' && parsed.packageManager.trim()
        ? parsed.packageManager.trim()
        : undefined;
    const scripts = stringMap(parsed.scripts);
    const dependencies = [
      ...new Set([
        ...dependencyNames(parsed.dependencies),
        ...dependencyNames(parsed.devDependencies),
        ...dependencyNames(parsed.peerDependencies),
      ]),
    ].sort();
    const workspaces = parseWorkspacesField(parsed.workspaces);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(packageManager !== undefined ? { packageManager } : {}),
      scripts,
      dependencies,
      workspaces,
    };
  } catch {
    return null;
  }
}

function parsePyprojectToml(source: string): ParsedPyproject {
  const projectSection = source.match(
    /^\s*\[project\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
  );
  const body = projectSection ? (projectSection[1] ?? source) : source;
  const nameMatch = body.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  const descMatch = body.match(/^\s*description\s*=\s*["']([^"']+)["']/m);
  const name = nameMatch?.[1]?.trim();
  const description = descMatch?.[1]?.trim();
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

function workspaceRootDirs(patterns: readonly string[]): string[] {
  const roots = new Set<string>(['apps', 'packages', 'libs']);
  for (const pattern of patterns) {
    const cleaned = pattern.trim().replace(/\/+\*.*$/, '');
    if (
      cleaned &&
      !cleaned.includes('*') &&
      !cleaned.includes('..') &&
      !cleaned.startsWith('/')
    ) {
      roots.add(cleaned);
    }
  }
  return [...roots];
}

async function discoverWorkspaces(
  projectDir: string,
  patterns: readonly string[],
): Promise<WorkspacePackageInfo[]> {
  const root = (await realLocation(projectDir)) ?? projectDir;
  const roots = workspaceRootDirs(patterns);
  const discovered: WorkspacePackageInfo[] = [];

  for (const rootDir of roots) {
    const dirLocation = await realLocation(join(root, rootDir));
    if (dirLocation === null || !isInside({ dir: root, path: dirLocation })) {
      continue;
    }
    const entries = await readDirIfExists(dirLocation);
    if (!entries) continue;
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (!entry.isDirectory()) continue;
      const relPkgDir = `${rootDir}/${entry.name}`;
      const pkgJsonSource = await readProjectFile({
        projectDir,
        relativePath: `${relPkgDir}/package.json`,
      });
      if (pkgJsonSource === null) continue;
      const parsed = parsePackageJson(pkgJsonSource);
      if (!parsed) continue;
      discovered.push({
        relativePath: relPkgDir,
        name: parsed.name ?? entry.name,
        ...(parsed.description !== undefined
          ? { description: parsed.description }
          : {}),
        scripts: parsed.scripts,
        dependencies: parsed.dependencies,
      });
    }
  }

  return discovered;
}

interface DetectPackageManagerParams {
  projectDir: string;
  pkg: ParsedPackageJson | null;
  hasPyproject: boolean;
}

async function detectPackageManager({
  projectDir,
  pkg,
  hasPyproject,
}: DetectPackageManagerParams): Promise<DetectedPackageManager | undefined> {
  const declared = pkg?.packageManager?.toLowerCase() ?? '';
  if (declared.startsWith('yarn@')) return 'yarn';
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('npm@')) return 'npm';

  if (await hasProjectFile({ projectDir, relativePath: 'yarn.lock' })) {
    return 'yarn';
  }
  if (await hasProjectFile({ projectDir, relativePath: '.yarnrc.yml' })) {
    return 'yarn';
  }
  if (await hasProjectFile({ projectDir, relativePath: 'pnpm-lock.yaml' })) {
    return 'pnpm';
  }
  if (await hasProjectFile({ projectDir, relativePath: 'package-lock.json' })) {
    return 'npm';
  }
  if (pkg !== null) return 'yarn';
  if (
    hasPyproject ||
    (await hasProjectFile({ projectDir, relativePath: 'uv.lock' }))
  ) {
    return 'uv';
  }
  return undefined;
}

interface ChoosePresetParams {
  hasNx: boolean;
  hasPackageJson: boolean;
  hasPyproject: boolean;
  rootDeps: ReadonlySet<string>;
}

function choosePreset({
  hasNx,
  hasPackageJson,
  hasPyproject,
  rootDeps,
}: ChoosePresetParams): PresetId | undefined {
  if (hasNx || rootDeps.has('nx') || rootDeps.has('@nx/workspace')) {
    return 'nx-monorepo';
  }
  if (rootDeps.has('expo') || rootDeps.has('react-native')) {
    return 'expo-app';
  }
  if (rootDeps.has('next')) {
    return 'nextjs-app';
  }
  if (rootDeps.has('@nestjs/core') || rootDeps.has('@nestjs/common')) {
    return 'nestjs-api';
  }
  if (
    rootDeps.has('vite') &&
    (rootDeps.has('react') || rootDeps.has('@vitejs/plugin-react'))
  ) {
    return 'vite-spa';
  }
  if (hasPyproject && !hasPackageJson) {
    return 'python-service';
  }
  if (hasPackageJson) {
    return 'node-tool';
  }
  if (hasPyproject) {
    return 'python-service';
  }
  return undefined;
}

interface CollectAdditiveParams {
  preset: PresetId | undefined;
  allDeps: ReadonlySet<string>;
  hasPrismaFiles: boolean;
  hasSupabaseFiles: boolean;
  hasComponentsJson: boolean;
  hasPyproject: boolean;
}

function collectAdditiveSelections({
  preset,
  allDeps,
  hasPrismaFiles,
  hasSupabaseFiles,
  hasComponentsJson,
  hasPyproject,
}: CollectAdditiveParams): { blocks: string[]; skills: string[] } {
  const blocks = new Set<string>();
  const skills = new Set<string>();

  if (preset === 'nx-monorepo') {
    if (allDeps.has('next')) {
      blocks.add('stack/nextjs');
      blocks.add('stack/tailwind-shadcn');
      skills.add('vercel-react-best-practices');
      skills.add('vercel-composition-patterns');
      skills.add('web-design-guidelines');
    }
    if (allDeps.has('@nestjs/core') || allDeps.has('@nestjs/common')) {
      blocks.add('stack/nestjs');
      skills.add('nestjs-module');
    }
    if (allDeps.has('expo') || allDeps.has('react-native')) {
      blocks.add('stack/expo-react-native');
      blocks.add('stack/tanstack-query');
      skills.add('eas-workflows');
      skills.add('eas-update');
      skills.add('expo-dev-client');
      skills.add('expo-upgrade');
      skills.add('expo-module');
      skills.add('react-native-best-practices');
      skills.add('react-navigation');
      skills.add('react-native-testing');
      skills.add('upgrading-react-native');
      skills.add('vercel-react-native-skills');
    }
    if (
      allDeps.has('vite') &&
      (allDeps.has('react') || allDeps.has('@vitejs/plugin-react'))
    ) {
      blocks.add('stack/react-vite');
      blocks.add('stack/tailwind-shadcn');
      blocks.add('stack/tanstack-query');
      skills.add('vercel-react-best-practices');
      skills.add('web-design-guidelines');
    }
  }

  const hasPrisma =
    hasPrismaFiles || allDeps.has('prisma') || allDeps.has('@prisma/client');
  if (hasPrisma) {
    blocks.add('stack/prisma');
    skills.add('prisma-cli');
    skills.add('prisma-client-api');
    skills.add('prisma-orm-setup');
    skills.add('prisma-upgrade-v7');
  }

  const hasSupabase =
    hasSupabaseFiles ||
    allDeps.has('@supabase/supabase-js') ||
    allDeps.has('@supabase/ssr');
  if (hasSupabase) {
    blocks.add('stack/supabase-prisma');
    skills.add('supabase-prisma');
    skills.add('supabase');
    skills.add('supabase-postgres-best-practices');
  }

  if (allDeps.has('@tanstack/react-query')) {
    blocks.add('stack/tanstack-query');
    skills.add('tanstack-query-expert');
  }

  if (
    hasComponentsJson ||
    allDeps.has('tailwindcss') ||
    allDeps.has('@tailwindcss/vite') ||
    allDeps.has('@tailwindcss/postcss')
  ) {
    blocks.add('stack/tailwind-shadcn');
    skills.add('tailwind-patterns');
  }

  const hasAiSdk =
    allDeps.has('ai') || [...allDeps].some((dep) => dep.startsWith('@ai-sdk/'));
  const hasAnthropicSdk = allDeps.has('@anthropic-ai/sdk');
  const hasLlm =
    hasAiSdk ||
    hasAnthropicSdk ||
    allDeps.has('openai') ||
    allDeps.has('@google/genai');
  if (hasLlm) {
    blocks.add('stack/llm-apps');
  }
  if (hasAiSdk) {
    skills.add('ai-sdk');
  }
  if (hasAnthropicSdk) {
    skills.add('claude-api');
  }

  if (allDeps.has('@playwright/test') || allDeps.has('playwright')) {
    skills.add('playwright-cli');
  }

  if (hasPyproject) {
    blocks.add('stack/python-uv');
  }

  return {
    blocks: [...blocks],
    skills: [...skills],
  };
}

async function hasAnyRelativeFile(
  projectDir: string,
  candidates: readonly string[],
): Promise<boolean> {
  for (const relativePath of candidates) {
    if (await hasProjectFile({ projectDir, relativePath })) {
      return true;
    }
  }
  return false;
}

export async function detectProject(
  projectDir: string,
): Promise<ProjectDetection> {
  const pkgSource = await readProjectFile({
    projectDir,
    relativePath: 'package.json',
  });
  const pkg = pkgSource !== null ? parsePackageJson(pkgSource) : null;
  const pyprojectSource = await readProjectFile({
    projectDir,
    relativePath: 'pyproject.toml',
  });
  const pyproject =
    pyprojectSource !== null ? parsePyprojectToml(pyprojectSource) : null;

  const hasNx = await hasProjectFile({ projectDir, relativePath: 'nx.json' });
  const nvmrcRaw = await readProjectFile({
    projectDir,
    relativePath: '.nvmrc',
  });
  const nvmrc = nvmrcRaw?.trim() || undefined;

  const workspaces = await discoverWorkspaces(
    projectDir,
    pkg?.workspaces ?? [],
  );
  const rootDeps = new Set(pkg?.dependencies ?? []);
  const allDeps = new Set<string>([
    ...rootDeps,
    ...workspaces.flatMap((ws) => ws.dependencies),
  ]);

  const workspacePrismaCandidates = workspaces.flatMap((ws) => [
    `${ws.relativePath}/prisma/schema.prisma`,
    `${ws.relativePath}/prisma.config.ts`,
  ]);
  const hasPrismaFiles = await hasAnyRelativeFile(projectDir, [
    'prisma/schema.prisma',
    'prisma.config.ts',
    ...workspacePrismaCandidates,
  ]);

  const workspaceSupabaseCandidates = workspaces.map(
    (ws) => `${ws.relativePath}/supabase/config.toml`,
  );
  const hasSupabaseFiles = await hasAnyRelativeFile(projectDir, [
    'supabase/config.toml',
    ...workspaceSupabaseCandidates,
  ]);

  const workspaceComponentsCandidates = workspaces.map(
    (ws) => `${ws.relativePath}/components.json`,
  );
  const hasComponentsJson = await hasAnyRelativeFile(projectDir, [
    'components.json',
    ...workspaceComponentsCandidates,
  ]);

  const preset = choosePreset({
    hasNx,
    hasPackageJson: pkg !== null,
    hasPyproject: pyproject !== null,
    rootDeps,
  });
  const packageManager = await detectPackageManager({
    projectDir,
    pkg,
    hasPyproject: pyproject !== null,
  });
  const additive = collectAdditiveSelections({
    preset,
    allDeps,
    hasPrismaFiles,
    hasSupabaseFiles,
    hasComponentsJson,
    hasPyproject: pyproject !== null,
  });

  const name = pkg?.name ?? pyproject?.name ?? basename(projectDir);
  const description = pkg?.description ?? pyproject?.description;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(preset !== undefined ? { preset } : {}),
    ...(packageManager !== undefined ? { packageManager } : {}),
    ...(nvmrc !== undefined ? { nvmrc } : {}),
    scripts: pkg?.scripts ?? {},
    hasNx,
    hasPyproject: pyproject !== null,
    workspaces,
    detectedBlocks: additive.blocks,
    detectedSkills: additive.skills,
  };
}
