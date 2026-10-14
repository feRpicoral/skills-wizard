import { basename, join } from 'node:path';

import {
  hasAnyRelativeFile,
  hasProjectFile,
  readProjectFile,
  safeRealLocation,
} from './boundary-fs.ts';
import {
  detectPackageManager,
  parsePackageJson,
  parsePnpmWorkspaceYaml,
  parsePyprojectToml,
} from './manifests.ts';
import {
  loadPresets,
  type PresetDefinition,
  type PresetId,
  presetsPath,
} from './presets.ts';
import { discoverWorkspaces, type WorkspacePackageInfo } from './workspaces.ts';

export { readProjectFile, type WorkspacePackageInfo };

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const CROSS_CUTTING_PRESET_BLOCKS: ReadonlySet<string> = new Set([
  'stack/tailwind-shadcn',
  'stack/tanstack-query',
]);

let cachedPresetsById: Promise<ReadonlyMap<PresetId, PresetDefinition>> | null =
  null;

function loadBundledPresetsById(): Promise<
  ReadonlyMap<PresetId, PresetDefinition>
> {
  cachedPresetsById ??= loadPresets(presetsPath(REPO_ROOT)).then(
    (presets) => new Map(presets.map((preset) => [preset.id, preset])),
  );
  return cachedPresetsById;
}

export type DetectedPackageManager =
  'yarn' | 'pnpm' | 'npm' | 'bun' | 'uv' | 'poetry';

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
  pythonPackageManager?: 'uv' | 'poetry';
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

function isViteSsrFramework(deps: ReadonlySet<string>): boolean {
  if (deps.has('@react-router/dev') || deps.has('@tanstack/react-start')) {
    return true;
  }
  return [...deps].some((dep) => dep.startsWith('@remix-run/'));
}

function detectNodePresets(deps: ReadonlySet<string>): Set<PresetId> {
  const presets = new Set<PresetId>();
  if (deps.has('expo')) presets.add('expo-app');
  if (deps.has('next')) presets.add('nextjs-app');
  if (deps.has('@nestjs/core') || deps.has('@nestjs/common')) {
    presets.add('nestjs-api');
  }
  if (
    deps.has('vite') &&
    (deps.has('react') || deps.has('@vitejs/plugin-react')) &&
    !isViteSsrFramework(deps)
  ) {
    presets.add('vite-spa');
  }
  return presets;
}

function choosePreset(params: {
  hasNx: boolean;
  hasPackageJson: boolean;
  hasPyproject: boolean;
  rootDeps: ReadonlySet<string>;
}): PresetId | undefined {
  const { hasNx, hasPackageJson, hasPyproject, rootDeps } = params;
  if (hasNx || rootDeps.has('nx') || rootDeps.has('@nx/workspace')) {
    return 'nx-monorepo';
  }
  const nodePresets = detectNodePresets(rootDeps);
  for (const candidate of [
    'expo-app',
    'nextjs-app',
    'nestjs-api',
    'vite-spa',
  ] as const) {
    if (nodePresets.has(candidate)) return candidate;
  }
  if (hasPyproject && !hasPackageJson) return 'python-service';
  if (hasPackageJson) return 'node-tool';
  if (hasPyproject) return 'python-service';
  return undefined;
}

function collectWorkspaceFrameworkSelections(
  allDeps: ReadonlySet<string>,
  presetsById: ReadonlyMap<PresetId, PresetDefinition>,
  blocks: Set<string>,
  skills: Set<string>,
): void {
  const nodePresets = detectNodePresets(allDeps);
  const basePreset = presetsById.get('node-tool');
  const baseBlocks = new Set(basePreset?.blocks ?? []);
  const baseSkills = new Set(basePreset?.skills ?? []);

  for (const presetId of [
    'nextjs-app',
    'nestjs-api',
    'expo-app',
    'vite-spa',
  ] as const) {
    if (!nodePresets.has(presetId)) continue;
    const preset = presetsById.get(presetId);
    if (!preset) continue;
    for (const blockId of preset.blocks) {
      if (
        !baseBlocks.has(blockId) &&
        !CROSS_CUTTING_PRESET_BLOCKS.has(blockId)
      ) {
        blocks.add(blockId);
      }
    }
    for (const skillName of preset.skills) {
      if (!baseSkills.has(skillName)) skills.add(skillName);
    }
  }
}

function collectCrossCuttingSelections(params: {
  hasNx: boolean;
  allDeps: ReadonlySet<string>;
  hasPrismaFiles: boolean;
  hasSupabaseFiles: boolean;
  hasSentry: boolean;
  hasComponentsJson: boolean;
  isUvProject: boolean;
  blocks: Set<string>;
  skills: Set<string>;
  mcpServers: Set<string>;
}): void {
  const {
    hasNx,
    allDeps,
    hasPrismaFiles,
    hasSupabaseFiles,
    hasSentry,
    hasComponentsJson,
    isUvProject,
    blocks,
    skills,
    mcpServers,
  } = params;
  if (hasNx || allDeps.has('nx') || allDeps.has('@nx/workspace')) {
    mcpServers.add('nx');
  }
  const hasPrisma =
    hasPrismaFiles || allDeps.has('prisma') || allDeps.has('@prisma/client');
  if (hasPrisma) {
    blocks.add('stack/prisma');
    for (const s of [
      'prisma-cli',
      'prisma-client-api',
      'prisma-orm-setup',
      'prisma-upgrade-v7',
    ]) {
      skills.add(s);
    }
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
  if (hasSentry) mcpServers.add('sentry');
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
  if (
    hasAiSdk ||
    hasAnthropicSdk ||
    allDeps.has('openai') ||
    allDeps.has('@google/genai')
  ) {
    blocks.add('stack/llm-apps');
  }
  if (hasAiSdk) skills.add('ai-sdk');
  if (hasAnthropicSdk) skills.add('claude-api');
  if (allDeps.has('@playwright/test') || allDeps.has('playwright')) {
    skills.add('playwright-cli');
  }
  if (isUvProject) blocks.add('stack/python-uv');
}

function collectAdditiveSelections(params: {
  hasNx: boolean;
  hasWorkspacePackages: boolean;
  allDeps: ReadonlySet<string>;
  presetsById: ReadonlyMap<PresetId, PresetDefinition>;
  hasPrismaFiles: boolean;
  hasSupabaseFiles: boolean;
  hasSentry: boolean;
  hasComponentsJson: boolean;
  isUvProject: boolean;
}): {
  blocks: string[];
  skills: string[];
  mcpServers: string[];
} {
  const blocks = new Set<string>();
  const skills = new Set<string>();
  const mcpServers = new Set<string>();

  if (params.hasWorkspacePackages) {
    collectWorkspaceFrameworkSelections(
      params.allDeps,
      params.presetsById,
      blocks,
      skills,
    );
  }
  collectCrossCuttingSelections({
    ...params,
    blocks,
    skills,
    mcpServers,
  });

  return {
    blocks: [...blocks],
    skills: [...skills],
    mcpServers: [...mcpServers],
  };
}

const SENTRY_ROOT_CANDIDATES = [
  'sentry.client.config.ts',
  'sentry.client.config.js',
  'sentry.server.config.ts',
  'sentry.server.config.js',
  '.sentryclirc',
] as const;

async function probeProjectMarkers(
  projectDir: string,
  root: string,
  workspaces: readonly WorkspacePackageInfo[],
) {
  const probe = (files: readonly string[]) =>
    hasAnyRelativeFile({
      projectDir,
      root,
      candidates: [
        ...files,
        ...workspaces.flatMap((ws) =>
          files.map((f) => `${ws.relativePath}/${f}`),
        ),
      ],
    });
  const [hasPrismaFiles, hasSupabaseFiles, hasComponentsJson, hasSentryFiles] =
    await Promise.all([
      probe(['prisma/schema.prisma', 'prisma.config.ts']),
      probe(['supabase/config.toml']),
      probe(['components.json']),
      probe(SENTRY_ROOT_CANDIDATES),
    ]);
  return {
    hasPrismaFiles,
    hasSupabaseFiles,
    hasComponentsJson,
    hasSentryFiles,
  };
}

/**
 * Inspects a project directory (`package.json`, `pyproject.toml`, lockfiles,
 * `.nvmrc`, `nx.json`, `pnpm-workspace.yaml`, and workspace packages) to infer
 * the project name, primary stack preset, package manager, scripts, and
 * additive blocks, skills, and MCP servers.
 */
export async function detectProject(
  projectDir: string,
): Promise<ProjectDetection> {
  const root = (await safeRealLocation(projectDir)) ?? projectDir;
  const [
    pkgSource,
    pyprojectSource,
    pnpmWorkspaceSource,
    hasNx,
    nvmrcRaw,
    hasUvLock,
    hasPoetryLock,
    presetsById,
  ] = await Promise.all([
    readProjectFile({ projectDir, relativePath: 'package.json', root }),
    readProjectFile({ projectDir, relativePath: 'pyproject.toml', root }),
    readProjectFile({
      projectDir,
      relativePath: 'pnpm-workspace.yaml',
      root,
    }),
    hasProjectFile({ projectDir, relativePath: 'nx.json', root }),
    readProjectFile({ projectDir, relativePath: '.nvmrc', root }),
    hasProjectFile({ projectDir, relativePath: 'uv.lock', root }),
    hasProjectFile({ projectDir, relativePath: 'poetry.lock', root }),
    loadBundledPresetsById(),
  ]);

  const pkg = pkgSource !== null ? parsePackageJson(pkgSource) : null;
  const pyproject =
    pyprojectSource !== null ? parsePyprojectToml(pyprojectSource) : null;
  const pnpmWorkspacePatterns =
    pnpmWorkspaceSource !== null
      ? parsePnpmWorkspaceYaml(pnpmWorkspaceSource)
      : [];
  const nvmrc = nvmrcRaw?.trim() || undefined;

  const workspacePatterns = [
    ...(pkg?.workspaces ?? []),
    ...pnpmWorkspacePatterns,
  ];
  const workspaces = await discoverWorkspaces({
    projectDir,
    root,
    patterns: workspacePatterns,
    hasNx,
  });
  const rootDeps = new Set(pkg?.dependencies ?? []);
  const allDeps = new Set<string>([
    ...rootDeps,
    ...workspaces.flatMap((ws) => ws.dependencies),
  ]);

  const [markers, packageManager] = await Promise.all([
    probeProjectMarkers(projectDir, root, workspaces),
    detectPackageManager({
      projectDir,
      root,
      pkg,
      pyproject,
      hasUvLock,
      hasPoetryLock,
    }),
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
  const isPoetryProject =
    Boolean(pyproject?.hasPoetrySection) ||
    hasPoetryLock ||
    packageManager === 'poetry';
  const isUvProject =
    Boolean(pyproject?.hasUvSection) ||
    hasUvLock ||
    packageManager === 'uv' ||
    (pyproject !== null && !isPoetryProject);
  const pythonPackageManager: 'uv' | 'poetry' | undefined =
    pyproject !== null
      ? isPoetryProject && !pyproject.hasUvSection && !hasUvLock
        ? 'poetry'
        : 'uv'
      : undefined;
  const additive = collectAdditiveSelections({
    hasNx,
    hasWorkspacePackages:
      hasNx || workspacePatterns.length > 0 || workspaces.length > 0,
    allDeps,
    presetsById,
    hasPrismaFiles: markers.hasPrismaFiles,
    hasSupabaseFiles: markers.hasSupabaseFiles,
    hasSentry: markers.hasSentryFiles || hasSentryDeps,
    hasComponentsJson: markers.hasComponentsJson,
    isUvProject,
  });

  const name = pkg?.name ?? pyproject?.name ?? basename(projectDir);
  const description = pkg?.description ?? pyproject?.description;

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(preset !== undefined ? { preset } : {}),
    ...(packageManager !== undefined ? { packageManager } : {}),
    ...(pythonPackageManager !== undefined ? { pythonPackageManager } : {}),
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
