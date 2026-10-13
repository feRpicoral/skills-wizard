import { basename, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { isSystemError } from '../errors.ts';
import {
  isInside,
  readDirIfExists,
  readTextIfExists,
  realLocation,
  statIfExists,
} from '../install/fs.ts';
import type { PresetId } from './presets.ts';

export type DetectedPackageManager =
  'yarn' | 'pnpm' | 'npm' | 'bun' | 'uv' | 'poetry';

export interface WorkspacePackageInfo {
  relativePath: string;
  name: string;
  description?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

export interface PythonToolSignals {
  hasRuff: boolean;
  hasMypy: boolean;
  hasPyright: boolean;
  hasPytest: boolean;
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
  pythonTools?: PythonToolSignals;
  workspaces: WorkspacePackageInfo[];
  detectedBlocks: string[];
  detectedSkills: string[];
  detectedMcpServers: string[];
}

export const DETECTABLE_MCP_SERVERS = ['nx', 'supabase', 'sentry'] as const;

export const DETECTABLE_BLOCKS = [
  'stack/nextjs',
  'stack/tailwind-shadcn',
  'stack/nestjs',
  'stack/expo-react-native',
  'stack/tanstack-query',
  'stack/react-vite',
  'stack/prisma',
  'stack/supabase-prisma',
  'stack/llm-apps',
  'stack/python-uv',
] as const;

export const DETECTABLE_SKILLS = [
  'vercel-react-best-practices',
  'vercel-composition-patterns',
  'web-design-guidelines',
  'nestjs-module',
  'eas-workflows',
  'eas-update',
  'expo-dev-client',
  'expo-upgrade',
  'expo-module',
  'react-native-best-practices',
  'react-navigation',
  'react-native-testing',
  'upgrading-react-native',
  'vercel-react-native-skills',
  'prisma-cli',
  'prisma-client-api',
  'prisma-orm-setup',
  'prisma-upgrade-v7',
  'supabase-prisma',
  'supabase',
  'supabase-postgres-best-practices',
  'tanstack-query-expert',
  'tailwind-patterns',
  'ai-sdk',
  'claude-api',
  'playwright-cli',
] as const;

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
  hasUvSection: boolean;
  hasPoetrySection: boolean;
  tools: PythonToolSignals;
}

async function safeRealLocation(path: string): Promise<string | null> {
  try {
    return await realLocation(path);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

async function resolveProjectFile({
  projectDir,
  relativePath,
}: BoundaryPathParams): Promise<string | null> {
  const root = (await safeRealLocation(projectDir)) ?? projectDir;
  const location = await safeRealLocation(join(root, relativePath));
  if (location === null || !isInside({ dir: root, path: location })) {
    return null;
  }
  try {
    if (!(await statIfExists(location))?.isFile()) return null;
    return location;
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}

export async function readProjectFile({
  projectDir,
  relativePath,
}: BoundaryPathParams): Promise<string | null> {
  const location = await resolveProjectFile({ projectDir, relativePath });
  if (location === null) return null;
  try {
    return await readTextIfExists(location);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
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

function extractTomlTableBody(source: string, header: string): string | null {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^\\s*\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    'm',
  );
  const match = source.match(pattern);
  return match?.[1] ?? null;
}

function extractTomlStringValue(
  tableBody: string,
  key: string,
): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1`, 'm');
  const value = tableBody.match(pattern)?.[2]?.trim();
  return value ? value : undefined;
}

function parsePyprojectToml(source: string): ParsedPyproject {
  const projectBody = extractTomlTableBody(source, 'project');
  const poetryBody = extractTomlTableBody(source, 'tool.poetry');
  const metadataBody = projectBody ?? poetryBody;
  const name = metadataBody
    ? extractTomlStringValue(metadataBody, 'name')
    : undefined;
  const description = metadataBody
    ? extractTomlStringValue(metadataBody, 'description')
    : undefined;

  const hasUvSection = /^\s*\[\[?tool\.uv(?:\]|\.)/m.test(source);
  const hasPoetrySection = /^\s*\[\[?tool\.poetry(?:\]|\.)/m.test(source);
  const hasRuff =
    /^\s*\[tool\.ruff(?:\]|\.)/m.test(source) || /\bruff\b/i.test(source);
  const hasMypy =
    /^\s*\[tool\.mypy(?:\]|\.)/m.test(source) || /\bmypy\b/i.test(source);
  const hasPyright =
    /^\s*\[tool\.pyright(?:\]|\.)/m.test(source) || /\bpyright\b/i.test(source);
  const hasPytest =
    /^\s*\[tool\.pytest(?:\]|\.)/m.test(source) || /\bpytest\b/i.test(source);

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    hasUvSection,
    hasPoetrySection,
    tools: {
      hasRuff,
      hasMypy,
      hasPyright,
      hasPytest,
    },
  };
}

function parsePnpmWorkspaceYaml(source: string): string[] {
  try {
    const parsed = parseYaml(source) as unknown;
    return parseWorkspacesField(parsed);
  } catch {
    return [];
  }
}

function sanitizeRelativePattern(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (
    !trimmed ||
    trimmed.startsWith('!') ||
    trimmed.startsWith('/') ||
    trimmed.split('/').includes('..')
  ) {
    return null;
  }
  return trimmed;
}

async function readWorkspacePackage(
  projectDir: string,
  relPkgDir: string,
): Promise<WorkspacePackageInfo | null> {
  const pkgJsonSource = await readProjectFile({
    projectDir,
    relativePath: `${relPkgDir}/package.json`,
  });
  if (pkgJsonSource === null) return null;
  const parsed = parsePackageJson(pkgJsonSource);
  if (!parsed) return null;
  const fallbackName = basename(relPkgDir);
  return {
    relativePath: relPkgDir,
    name: parsed.name ?? fallbackName,
    ...(parsed.description !== undefined
      ? { description: parsed.description }
      : {}),
    scripts: parsed.scripts,
    dependencies: parsed.dependencies,
  };
}

async function scanWorkspaceChildren(
  projectDir: string,
  root: string,
  baseDir: string,
  recursive: boolean,
  seen: Set<string>,
  discovered: WorkspacePackageInfo[],
  depth = 0,
): Promise<void> {
  if (depth > 3) return;
  const dirLocation = await safeRealLocation(join(root, baseDir));
  if (dirLocation === null || !isInside({ dir: root, path: dirLocation })) {
    return;
  }
  let entries;
  try {
    entries = await readDirIfExists(dirLocation);
  } catch (error) {
    if (isSystemError(error)) return;
    throw error;
  }
  if (!entries) return;
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (
      !entry.isDirectory() ||
      entry.name === 'node_modules' ||
      entry.name.startsWith('.')
    ) {
      continue;
    }
    const relPkgDir = `${baseDir}/${entry.name}`;
    if (!seen.has(relPkgDir)) {
      const info = await readWorkspacePackage(projectDir, relPkgDir);
      if (info) {
        seen.add(relPkgDir);
        discovered.push(info);
      }
    }
    if (recursive) {
      await scanWorkspaceChildren(
        projectDir,
        root,
        relPkgDir,
        true,
        seen,
        discovered,
        depth + 1,
      );
    }
  }
}

interface DiscoverWorkspacesParams {
  projectDir: string;
  patterns: readonly string[];
  hasNx: boolean;
}

async function discoverWorkspaces({
  projectDir,
  patterns,
  hasNx,
}: DiscoverWorkspacesParams): Promise<WorkspacePackageInfo[]> {
  const effectivePatterns =
    patterns.length > 0
      ? patterns
      : hasNx
        ? ['apps/*', 'packages/*', 'libs/*']
        : [];
  if (effectivePatterns.length === 0) return [];

  const root = (await safeRealLocation(projectDir)) ?? projectDir;
  const seen = new Set<string>();
  const discovered: WorkspacePackageInfo[] = [];

  for (const rawPattern of effectivePatterns) {
    const cleaned = sanitizeRelativePattern(rawPattern);
    if (!cleaned) continue;

    if (!cleaned.includes('*')) {
      if (seen.has(cleaned)) continue;
      const dirLocation = await safeRealLocation(join(root, cleaned));
      if (dirLocation === null || !isInside({ dir: root, path: dirLocation })) {
        continue;
      }
      const info = await readWorkspacePackage(projectDir, cleaned);
      if (info) {
        seen.add(cleaned);
        discovered.push(info);
      }
      continue;
    }

    const recursive = cleaned.includes('**');
    const parentDir = cleaned.replace(/\/+\*.*$/, '');
    if (!parentDir || parentDir.includes('*')) continue;
    await scanWorkspaceChildren(
      projectDir,
      root,
      parentDir,
      recursive,
      seen,
      discovered,
    );
  }

  return discovered;
}

interface DetectPackageManagerParams {
  projectDir: string;
  pkg: ParsedPackageJson | null;
  pyproject: ParsedPyproject | null;
}

async function detectPackageManager({
  projectDir,
  pkg,
  pyproject,
}: DetectPackageManagerParams): Promise<DetectedPackageManager | undefined> {
  const declared = pkg?.packageManager?.toLowerCase() ?? '';
  if (declared.startsWith('yarn@')) return 'yarn';
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('npm@')) return 'npm';
  if (declared.startsWith('bun@')) return 'bun';

  if (await hasProjectFile({ projectDir, relativePath: 'yarn.lock' })) {
    return 'yarn';
  }
  if (await hasProjectFile({ projectDir, relativePath: 'pnpm-lock.yaml' })) {
    return 'pnpm';
  }
  if (
    (await hasProjectFile({ projectDir, relativePath: 'package-lock.json' })) ||
    (await hasProjectFile({ projectDir, relativePath: 'npm-shrinkwrap.json' }))
  ) {
    return 'npm';
  }
  if (
    (await hasProjectFile({ projectDir, relativePath: 'bun.lock' })) ||
    (await hasProjectFile({ projectDir, relativePath: 'bun.lockb' }))
  ) {
    return 'bun';
  }
  if (await hasProjectFile({ projectDir, relativePath: '.yarnrc.yml' })) {
    return 'yarn';
  }
  if (pkg !== null) return 'yarn';

  if (
    pyproject?.hasUvSection ||
    (await hasProjectFile({ projectDir, relativePath: 'uv.lock' }))
  ) {
    return 'uv';
  }
  if (
    pyproject?.hasPoetrySection ||
    (await hasProjectFile({ projectDir, relativePath: 'poetry.lock' }))
  ) {
    return 'poetry';
  }
  return undefined;
}

function isViteSsrFramework(deps: ReadonlySet<string>): boolean {
  if (deps.has('@react-router/dev') || deps.has('@tanstack/react-start')) {
    return true;
  }
  return [...deps].some((dep) => dep.startsWith('@remix-run/'));
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
  if (rootDeps.has('expo')) {
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
    (rootDeps.has('react') || rootDeps.has('@vitejs/plugin-react')) &&
    !isViteSsrFramework(rootDeps)
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
  hasNx: boolean;
  hasWorkspacePackages: boolean;
  allDeps: ReadonlySet<string>;
  hasPrismaFiles: boolean;
  hasSupabaseFiles: boolean;
  hasSentry: boolean;
  hasComponentsJson: boolean;
  isUvProject: boolean;
}

function collectAdditiveSelections({
  hasNx,
  hasWorkspacePackages,
  allDeps,
  hasPrismaFiles,
  hasSupabaseFiles,
  hasSentry,
  hasComponentsJson,
  isUvProject,
}: CollectAdditiveParams): {
  blocks: string[];
  skills: string[];
  mcpServers: string[];
} {
  const blocks = new Set<string>();
  const skills = new Set<string>();
  const mcpServers = new Set<string>();

  if (hasNx || allDeps.has('nx') || allDeps.has('@nx/workspace')) {
    mcpServers.add('nx');
  }

  if (hasWorkspacePackages) {
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
    if (allDeps.has('expo')) {
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
      (allDeps.has('react') || allDeps.has('@vitejs/plugin-react')) &&
      !isViteSsrFramework(allDeps)
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
    if (hasPrisma) {
      blocks.add('stack/supabase-prisma');
      skills.add('supabase-prisma');
    }
    skills.add('supabase');
    skills.add('supabase-postgres-best-practices');
    mcpServers.add('supabase');
  }

  if (hasSentry) {
    mcpServers.add('sentry');
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

  if (isUvProject) {
    blocks.add('stack/python-uv');
  }

  return {
    blocks: [...blocks],
    skills: [...skills],
    mcpServers: [...mcpServers],
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

  const pnpmWorkspaceSource = await readProjectFile({
    projectDir,
    relativePath: 'pnpm-workspace.yaml',
  });
  const pnpmWorkspacePatterns =
    pnpmWorkspaceSource !== null
      ? parsePnpmWorkspaceYaml(pnpmWorkspaceSource)
      : [];

  const hasNx = await hasProjectFile({ projectDir, relativePath: 'nx.json' });
  const nvmrcRaw = await readProjectFile({
    projectDir,
    relativePath: '.nvmrc',
  });
  const nvmrc = nvmrcRaw?.trim() || undefined;

  const workspacePatterns = [
    ...(pkg?.workspaces ?? []),
    ...pnpmWorkspacePatterns,
  ];
  const workspaces = await discoverWorkspaces({
    projectDir,
    patterns: workspacePatterns,
    hasNx,
  });
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

  const sentryRootCandidates = [
    'sentry.client.config.ts',
    'sentry.client.config.js',
    'sentry.server.config.ts',
    'sentry.server.config.js',
    '.sentryclirc',
  ];
  const workspaceSentryCandidates = workspaces.flatMap((ws) =>
    sentryRootCandidates.map((file) => `${ws.relativePath}/${file}`),
  );
  const hasSentryFiles = await hasAnyRelativeFile(projectDir, [
    ...sentryRootCandidates,
    ...workspaceSentryCandidates,
  ]);
  const hasSentryDeps =
    [...allDeps].some((dep) => dep.startsWith('@sentry/')) ||
    (pyprojectSource !== null && /\bsentry[-_]sdk\b/i.test(pyprojectSource));

  const preset = choosePreset({
    hasNx,
    hasPackageJson: pkg !== null,
    hasPyproject: pyproject !== null,
    rootDeps,
  });
  const packageManager = await detectPackageManager({
    projectDir,
    pkg,
    pyproject,
  });
  const additive = collectAdditiveSelections({
    hasNx,
    hasWorkspacePackages:
      hasNx || workspacePatterns.length > 0 || workspaces.length > 0,
    allDeps,
    hasPrismaFiles,
    hasSupabaseFiles,
    hasSentry: hasSentryFiles || hasSentryDeps,
    hasComponentsJson,
    isUvProject: packageManager === 'uv',
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
    ...(pyproject !== null ? { pythonTools: pyproject.tools } : {}),
    workspaces,
    detectedBlocks: additive.blocks,
    detectedSkills: additive.skills,
    detectedMcpServers: additive.mcpServers,
  };
}
