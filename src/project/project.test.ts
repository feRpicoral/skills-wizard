import assert from 'node:assert/strict';
import { chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadBlockLibrary } from '../blocks/library.ts';
import { PresetError } from '../errors.ts';
import { findMcpServer, loadMcpCatalog, mcpCatalogPath } from '../mcp/model.ts';
import { findSkill, loadSkillLibrary } from '../skills/library.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  DETECTABLE_BLOCKS,
  DETECTABLE_MCP_SERVERS,
  DETECTABLE_SKILLS,
  detectProject,
} from './detect.ts';
import {
  findPreset,
  isPresetId,
  isProjectStyle,
  loadPresets,
  PRESET_IDS,
  presetsPath,
  resolvePresetSelection,
  resolveProjectPresetAndStyle,
} from './presets.ts';
import { buildProjectSeed, formatCodeSpan } from './seed.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

test('loadPresets loads and validates all seven repository presets against block and skill libraries', async () => {
  const blockLibrary = await loadBlockLibrary(join(REPO_ROOT, 'blocks'));
  const skillLibrary = await loadSkillLibrary(REPO_ROOT);

  const presets = await loadPresets(presetsPath(REPO_ROOT), {
    blockLibrary,
    skillLibrary,
  });

  assert.deepEqual(
    presets.map((preset) => preset.id),
    [...PRESET_IDS],
  );
  assert.equal(isPresetId('nextjs-app'), true);
  assert.equal(isPresetId('unknown-preset'), false);
  assert.equal(isProjectStyle('lean'), true);
  assert.equal(isProjectStyle('self-contained'), true);
  assert.equal(isProjectStyle('custom'), false);
});

test('every detectable block and skill in detect.ts exists and is project-scoped', async () => {
  const blockLibrary = await loadBlockLibrary(join(REPO_ROOT, 'blocks'));
  const skillLibrary = await loadSkillLibrary(REPO_ROOT);
  const blocksById = new Map(
    blockLibrary.blocks.map((block) => [block.id, block]),
  );

  for (const blockId of DETECTABLE_BLOCKS) {
    const block = blocksById.get(blockId);
    assert.ok(block, `Missing detectable block: ${blockId}`);
    assert.equal(
      block.scopes.includes('project'),
      true,
      `Block ${blockId} is not project-scoped`,
    );
  }

  for (const skillName of DETECTABLE_SKILLS) {
    const skill = findSkill(skillLibrary, skillName);
    assert.ok(skill, `Missing detectable skill: ${skillName}`);
    assert.equal(
      skill.scopes.includes('project'),
      true,
      `Skill ${skillName} is not project-scoped`,
    );
  }

  const mcpCatalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));
  for (const serverName of DETECTABLE_MCP_SERVERS) {
    const server = findMcpServer(mcpCatalog, serverName);
    assert.ok(server, `Missing detectable MCP server: ${serverName}`);
    assert.equal(
      server.scopes.includes('project'),
      true,
      `MCP server ${serverName} is not project-scoped`,
    );
  }
});

test('loadPresets rejects missing preset files or unknown block references', async (t) => {
  const root = await tempDir(t);
  const blockLibrary = await loadBlockLibrary(join(REPO_ROOT, 'blocks'));
  await writeFiles(root, {
    'nextjs-app.yaml': [
      'id: nextjs-app',
      'name: Next.js App',
      'description: Next.js app',
      'blocks:',
      '  - stack/unknown-block',
      'skills: []',
      '',
    ].join('\n'),
  });

  const action = () => loadPresets(root, { blockLibrary });

  await assert.rejects(action, PresetError);
});

test('resolvePresetSelection respects style and omits stack/node-yarn for non-yarn package managers', async () => {
  const blockLibrary = await loadBlockLibrary(join(REPO_ROOT, 'blocks'));
  const skillLibrary = await loadSkillLibrary(REPO_ROOT);
  const presets = await loadPresets(presetsPath(REPO_ROOT), {
    blockLibrary,
    skillLibrary,
  });
  const nestPreset = findPreset(presets, 'nestjs-api');

  const leanYarn = resolvePresetSelection({
    preset: nestPreset,
    style: 'lean',
    blockLibrary,
    skillLibrary,
    packageManager: 'yarn',
    detectedBlocks: ['stack/supabase-prisma'],
    detectedSkills: ['supabase-prisma'],
  });
  const leanPnpm = resolvePresetSelection({
    preset: nestPreset,
    style: 'lean',
    blockLibrary,
    skillLibrary,
    packageManager: 'pnpm',
  });
  const selfContained = resolvePresetSelection({
    preset: nestPreset,
    style: 'self-contained',
    blockLibrary,
    skillLibrary,
  });

  assert.deepEqual(leanYarn.blocks, [
    'stack/typescript',
    'stack/node-yarn',
    'stack/lint-format',
    'stack/nestjs',
    'stack/supabase-prisma',
  ]);
  assert.deepEqual(leanPnpm.blocks, [
    'stack/typescript',
    'stack/lint-format',
    'stack/nestjs',
  ]);
  assert.deepEqual(leanYarn.skills, [
    'eslint-configuration',
    'prettier-configuration',
    'nestjs-module',
    'supabase-prisma',
  ]);
  assert.equal(selfContained.blocks.includes('engineering/testing'), true);
  assert.equal(selfContained.blocks.includes('git/commits'), true);
  assert.equal(selfContained.blocks.includes('stack/nestjs'), true);
  assert.equal(selfContained.blocks.includes('core/identity'), false);
});

test('detectProject identifies nextjs-app, nestjs-api, expo-app, vite-spa, python-service, and node-tool', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'next/package.json': JSON.stringify({
      name: 'web',
      dependencies: { next: '15.0.0', react: '19.0.0' },
    }),
    'nest/package.json': JSON.stringify({
      name: 'api',
      dependencies: { '@nestjs/core': '11.0.0' },
    }),
    'expo/package.json': JSON.stringify({
      name: 'mobile',
      dependencies: { expo: '52.0.0', 'react-native': '0.76.0' },
    }),
    'vite/package.json': JSON.stringify({
      name: 'spa',
      dependencies: { react: '19.0.0' },
      devDependencies: { vite: '6.0.0' },
    }),
    'python/pyproject.toml':
      '[project]\nname = "worker"\ndescription = "Job worker"\n\n[tool.uv]\ndev-dependencies = ["ruff"]\n',
    'tool/package.json': JSON.stringify({
      name: 'cli-tool',
      devDependencies: { typescript: '5.8.0' },
    }),
  });

  const detected = await Promise.all([
    detectProject(join(root, 'next')),
    detectProject(join(root, 'nest')),
    detectProject(join(root, 'expo')),
    detectProject(join(root, 'vite')),
    detectProject(join(root, 'python')),
    detectProject(join(root, 'tool')),
  ]);

  assert.deepEqual(
    detected.map((item) => item.preset),
    [
      'nextjs-app',
      'nestjs-api',
      'expo-app',
      'vite-spa',
      'python-service',
      'node-tool',
    ],
  );
  assert.equal(detected[4]?.name, 'worker');
  assert.equal(detected[4]?.packageManager, 'uv');
  assert.equal(detected[4]?.detectedBlocks.includes('stack/python-uv'), true);
});

test('detectProject handles package managers, lockfile precedence, Poetry vs uv, and pyproject quotes', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'pnpm-beats-yarnrc/package.json': JSON.stringify({ name: 'pnpm-app' }),
    'pnpm-beats-yarnrc/.yarnrc.yml': 'nodeLinker: node-modules\n',
    'pnpm-beats-yarnrc/pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'npm-lock/package.json': JSON.stringify({ name: 'npm-app' }),
    'npm-lock/package-lock.json': '{}\n',
    'bun-lock/package.json': JSON.stringify({ name: 'bun-app' }),
    'bun-lock/bun.lock': '{}\n',
    'poetry-proj/pyproject.toml': [
      '[tool.poetry]',
      'name = "poetry-svc"',
      'description = "Worker for O\'Reilly feeds"',
      '',
      '[tool.ruff]',
      'line-length = 100',
      '',
    ].join('\n'),
    'poetry-proj/poetry.lock': '# poetry lock\n',
    'uv-index-only/pyproject.toml': [
      '[[tool.uv.index]]',
      'name = "pytorch-cpu"',
      'url = "https://download.pytorch.org/whl/cpu"',
      '',
    ].join('\n'),
  });

  const [pnpmApp, npmApp, bunApp, poetryProj, uvIndexOnly] = await Promise.all([
    detectProject(join(root, 'pnpm-beats-yarnrc')),
    detectProject(join(root, 'npm-lock')),
    detectProject(join(root, 'bun-lock')),
    detectProject(join(root, 'poetry-proj')),
    detectProject(join(root, 'uv-index-only')),
  ]);

  assert.equal(pnpmApp.packageManager, 'pnpm');
  assert.equal(npmApp.packageManager, 'npm');
  assert.equal(bunApp.packageManager, 'bun');
  assert.equal(poetryProj.packageManager, 'poetry');
  assert.equal(poetryProj.name, 'poetry-svc');
  assert.equal(poetryProj.description, "Worker for O'Reilly feeds");
  assert.equal(poetryProj.detectedBlocks.includes('stack/python-uv'), false);
  assert.equal(uvIndexOnly.name, 'uv-index-only');
  assert.equal(uvIndexOnly.packageManager, 'uv');
});

test('detectProject requires expo for expo-app, skips vite-spa on SSR frameworks, and ignores peerDependencies', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'bare-rn/package.json': JSON.stringify({
      name: 'bare-rn',
      dependencies: { 'react-native': '0.76.0' },
    }),
    'rn-peer-lib/package.json': JSON.stringify({
      name: 'rn-peer-lib',
      peerDependencies: { expo: '^52.0.0', 'react-native': '*' },
      devDependencies: { typescript: '^5.8.0' },
    }),
    'react-router-ssr/package.json': JSON.stringify({
      name: 'rr-ssr',
      dependencies: { react: '19.0.0', '@react-router/dev': '7.0.0' },
      devDependencies: { vite: '6.0.0' },
    }),
    'supabase-only/package.json': JSON.stringify({
      name: 'supabase-only',
      dependencies: { next: '15.0.0', '@supabase/supabase-js': '2.0.0' },
    }),
  });

  const [bareRn, rnPeerLib, rrSsr, supabaseOnly] = await Promise.all([
    detectProject(join(root, 'bare-rn')),
    detectProject(join(root, 'rn-peer-lib')),
    detectProject(join(root, 'react-router-ssr')),
    detectProject(join(root, 'supabase-only')),
  ]);

  assert.equal(bareRn.preset, 'node-tool');
  assert.equal(rnPeerLib.preset, 'node-tool');
  assert.equal(rrSsr.preset, 'node-tool');
  assert.equal(supabaseOnly.preset, 'nextjs-app');
  assert.equal(
    supabaseOnly.detectedBlocks.includes('stack/supabase-prisma'),
    false,
  );
  assert.equal(supabaseOnly.detectedSkills.includes('supabase-prisma'), false);
  assert.equal(supabaseOnly.detectedSkills.includes('supabase'), true);
  assert.equal(
    supabaseOnly.detectedSkills.includes('supabase-postgres-best-practices'),
    true,
  );
});

test('detectProject unions workspace stacks across nx, pnpm-workspace.yaml, and exact workspace paths without scanning stray folders', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'nx/nx.json': '{}\n',
    'nx/.nvmrc': '24\n',
    'nx/package.json': JSON.stringify({
      name: 'acme-platform',
      description: 'Acme monorepo platform',
      packageManager: 'yarn@4.12.0',
      scripts: {
        build: 'nx run-many -t build',
        lint: 'nx run-many -t lint',
        test: 'nx run-many -t test',
      },
      devDependencies: {
        '@playwright/test': '^1.50.0',
        nx: '^20.0.0',
      },
    }),
    'nx/apps/web/package.json': JSON.stringify({
      name: '@acme/web',
      description: 'Customer web dashboard',
      dependencies: {
        next: '15.0.0',
        react: '19.0.0',
        ai: '4.0.0',
        '@tanstack/react-query': '5.0.0',
      },
    }),
    'nx/apps/api/package.json': JSON.stringify({
      name: '@acme/api',
      description: 'Core NestJS API',
      dependencies: {
        '@nestjs/core': '11.0.0',
        '@prisma/client': '7.0.0',
        '@supabase/supabase-js': '2.0.0',
        '@anthropic-ai/sdk': '0.36.0',
      },
    }),
    'pnpm-ws/package.json': JSON.stringify({
      name: 'turbo-monorepo',
      packageManager: 'pnpm@10.0.0',
    }),
    'pnpm-ws/pnpm-workspace.yaml': 'packages:\n  - website\n  - services/*\n',
    'pnpm-ws/website/package.json': JSON.stringify({
      name: '@turbo/website',
      dependencies: { next: '15.0.0' },
    }),
    'pnpm-ws/services/orders/package.json': JSON.stringify({
      name: '@turbo/orders',
      dependencies: { '@nestjs/core': '11.0.0' },
    }),
    'single-pkg/package.json': JSON.stringify({
      name: 'single-pkg',
      dependencies: { commander: '12.0.0' },
    }),
    'single-pkg/packages/example-app/package.json': JSON.stringify({
      name: 'example-app',
      dependencies: { next: '15.0.0', openai: '4.0.0' },
    }),
  });

  const [nxDetection, pnpmWs, singlePkg] = await Promise.all([
    detectProject(join(root, 'nx')),
    detectProject(join(root, 'pnpm-ws')),
    detectProject(join(root, 'single-pkg')),
  ]);

  assert.equal(nxDetection.preset, 'nx-monorepo');
  assert.equal(nxDetection.nvmrc, '24');
  assert.equal(nxDetection.workspaces.length, 2);
  assert.equal(nxDetection.detectedBlocks.includes('stack/nextjs'), true);
  assert.equal(nxDetection.detectedBlocks.includes('stack/nestjs'), true);
  assert.equal(nxDetection.detectedBlocks.includes('stack/prisma'), true);
  assert.equal(
    nxDetection.detectedBlocks.includes('stack/supabase-prisma'),
    true,
  );
  assert.equal(nxDetection.detectedBlocks.includes('stack/llm-apps'), true);
  assert.equal(nxDetection.detectedSkills.includes('nestjs-module'), true);
  assert.equal(nxDetection.detectedSkills.includes('supabase-prisma'), true);
  assert.equal(nxDetection.detectedSkills.includes('ai-sdk'), true);
  assert.equal(nxDetection.detectedSkills.includes('claude-api'), true);
  assert.equal(nxDetection.detectedSkills.includes('playwright-cli'), true);
  assert.deepEqual(nxDetection.detectedMcpServers, ['nx', 'supabase']);

  assert.deepEqual(
    pnpmWs.workspaces.map((ws) => ws.relativePath),
    ['website', 'services/orders'],
  );
  assert.equal(pnpmWs.detectedBlocks.includes('stack/nextjs'), true);
  assert.equal(pnpmWs.detectedBlocks.includes('stack/nestjs'), true);
  assert.equal(pnpmWs.detectedSkills.includes('nestjs-module'), true);

  assert.deepEqual(singlePkg.workspaces, []);
  assert.equal(singlePkg.detectedBlocks.includes('stack/llm-apps'), false);
});

test('detectProject ignores symlinks that escape the project directory and survives ELOOP/EACCES probes', async (t) => {
  const outer = await tempDir(t);
  const projectDir = join(outer, 'project');
  await writeFiles(outer, {
    'outside.json': JSON.stringify({
      name: 'escaped',
      dependencies: { next: '15.0.0' },
    }),
    'project/package.json': JSON.stringify({
      name: 'resilient-repo',
      workspaces: ['apps/*'],
    }),
    'project/apps/good/package.json': JSON.stringify({
      name: '@resilient/good',
      dependencies: { '@nestjs/core': '11.0.0' },
    }),
    'project/apps/locked/package.json': JSON.stringify({
      name: '@resilient/locked',
    }),
  });
  await symlink(
    join(projectDir, 'prisma.config.ts'),
    join(projectDir, 'prisma.config.ts'),
  );
  await symlink(
    join(outer, 'outside.json'),
    join(projectDir, 'components.json'),
  );
  const lockedDir = join(projectDir, 'apps', 'locked');
  await chmod(lockedDir, 0o000);
  let detection;
  try {
    detection = await detectProject(projectDir);
  } finally {
    await chmod(lockedDir, 0o755).catch(() => {});
  }

  assert.equal(detection.name, 'resilient-repo');
  assert.deepEqual(
    detection.workspaces.map((ws) => ws.relativePath),
    ['apps/good'],
  );
  assert.equal(detection.detectedBlocks.includes('stack/nestjs'), true);
  assert.equal(
    detection.detectedBlocks.includes('stack/tailwind-shadcn'),
    false,
  );
});

test('buildProjectSeed renders consistent commands for yarn, npm, pnpm, uv, Poetry, and scripts with backticks', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'minimal/package.json': JSON.stringify({ name: 'tiny-pkg' }),
    'rich/.nvmrc': '24\n',
    'rich/package.json': JSON.stringify({
      name: 'acme-monorepo',
      description: 'Multi-package workspace for Acme.',
      packageManager: 'yarn@4.12.0',
      workspaces: ['apps/*'],
      scripts: {
        test: 'vitest run',
        dev: 'nx serve web',
        lint: 'eslint .',
        build: 'echo `date`\n&& tsc',
        postinstall: 'husky',
      },
    }),
    'rich/apps/web/package.json': JSON.stringify({
      name: '@acme/web',
      description: 'Next.js storefront',
    }),
    'npm-nx/nx.json': '{}\n',
    'npm-nx/package.json': JSON.stringify({ name: 'npm-nx' }),
    'npm-nx/package-lock.json': '{}\n',
    'uv-py/pyproject.toml':
      '[project]\nname = "uv-svc"\n\n[tool.uv]\ndev-dependencies = ["mypy", "ruff", "pytest"]\n',
    'poetry-py/pyproject.toml':
      '[tool.poetry]\nname = "poetry-svc"\n\n[tool.mypy]\nstrict = true\n',
    'poetry-py/poetry.lock': '# lock\n',
  });

  const [minimal, rich, npmNx, uvPy, poetryPy] = await Promise.all([
    detectProject(join(root, 'minimal')),
    detectProject(join(root, 'rich')),
    detectProject(join(root, 'npm-nx')),
    detectProject(join(root, 'uv-py')),
    detectProject(join(root, 'poetry-py')),
  ]);

  const minimalSeed = buildProjectSeed(minimal);
  const richSeed = buildProjectSeed(rich);
  const npmNxSeed = buildProjectSeed(npmNx);
  const uvSeed = buildProjectSeed(uvPy);
  const poetrySeed = buildProjectSeed(poetryPy);

  assert.equal(minimalSeed, '# tiny-pkg');
  assert.equal(richSeed.includes('# acme-monorepo'), true);
  assert.equal(
    richSeed.includes('- Setup: `nvm use && corepack enable && yarn install`'),
    true,
  );
  assert.equal(richSeed.includes('- `yarn dev`: `nx serve web`'), true);
  assert.equal(
    richSeed.includes('- `yarn build`: ``echo `date` && tsc``'),
    true,
  );
  assert.equal(richSeed.includes('postinstall'), false);
  assert.equal(
    richSeed.includes('- `apps/web` (`@acme/web`): Next.js storefront'),
    true,
  );
  assert.equal(
    npmNxSeed.includes(
      '- Run workspace targets: `npx nx run-many -t lint,test,build`',
    ),
    true,
  );
  assert.equal(uvSeed.includes('- Typecheck: `uv run mypy --strict`'), true);
  assert.equal(uvSeed.includes('pyright'), false);
  assert.equal(
    poetrySeed.includes('- Install dependencies: `poetry install`'),
    true,
  );
  assert.equal(
    poetrySeed.includes('- Typecheck: `poetry run mypy --strict`'),
    true,
  );
  assert.equal(poetrySeed.includes('uv sync'), false);
  assert.equal(formatCodeSpan('`leading`'), '`` `leading` ``');
});

test('detectProject and buildProjectSeed handle workspace glob prefixes/exclusions, polyglot repos, and pyproject comments/escapes', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'globs/package.json': JSON.stringify({
      name: 'glob-monorepo',
      workspaces: ['apps/web-*', 'packages/*/*', '!packages/internal/*'],
    }),
    'globs/apps/web-store/package.json': JSON.stringify({
      name: '@glob/web-store',
      dependencies: { next: '15.0.0' },
    }),
    'globs/apps/api/package.json': JSON.stringify({
      name: '@glob/api',
      dependencies: { '@nestjs/core': '11.0.0' },
    }),
    'globs/packages/ui/button/package.json': JSON.stringify({
      name: '@glob/button',
    }),
    'globs/packages/internal/secret/package.json': JSON.stringify({
      name: '@glob/secret',
    }),
    'polyglot/package.json': JSON.stringify({
      name: 'polyglot-repo',
      scripts: { build: 'tsc' },
    }),
    'polyglot/pyproject.toml': [
      '[project] # inline comment on header',
      'name = "polyglot-py"',
      'description = """',
      'Multi-line description mentioning ruff and pytest without configuring them.',
      '"""',
      '# [tool.ruff]',
      '# ruff = true',
      '',
      '[tool.uv]',
      'dev-dependencies = ["pytest>=8.0"]',
      '',
    ].join('\n'),
  });

  const [globs, polyglot] = await Promise.all([
    detectProject(join(root, 'globs')),
    detectProject(join(root, 'polyglot')),
  ]);

  assert.deepEqual(
    globs.workspaces.map((ws) => ws.relativePath),
    ['apps/web-store', 'packages/ui/button'],
  );
  assert.equal(globs.detectedBlocks.includes('stack/nextjs'), true);
  assert.equal(globs.detectedBlocks.includes('stack/tailwind-shadcn'), false);
  assert.equal(globs.detectedBlocks.includes('stack/nestjs'), false);

  assert.equal(polyglot.packageManager, 'uv');
  assert.equal(polyglot.detectedBlocks.includes('stack/python-uv'), true);
  assert.equal(polyglot.pythonTools?.hasRuff, false);
  assert.equal(polyglot.pythonTools?.hasPytest, true);

  const polyglotSeed = buildProjectSeed(polyglot);
  assert.equal(polyglotSeed.includes('- Install: `yarn install`'), true);
  assert.equal(polyglotSeed.includes('- `yarn build`: `tsc`'), true);
  assert.equal(
    polyglotSeed.includes('- Install dependencies: `uv sync`'),
    true,
  );
  assert.equal(polyglotSeed.includes('- Run tests: `uv run pytest`'), true);
  assert.equal(polyglotSeed.includes('ruff check'), false);
});

test('resolveProjectPresetAndStyle prompts on interactive re-runs with detected hint, and polyglot repos preserve yarn and poetry', async (t) => {
  const blockLibrary = await loadBlockLibrary(join(REPO_ROOT, 'blocks'));
  const skillLibrary = await loadSkillLibrary(REPO_ROOT);
  const presets = await loadPresets(presetsPath(REPO_ROOT), {
    blockLibrary,
    skillLibrary,
  });
  const nextPreset = findPreset(presets, 'nextjs-app');

  const uvNext = resolvePresetSelection({
    preset: nextPreset,
    style: 'lean',
    blockLibrary,
    skillLibrary,
    packageManager: 'uv',
  });
  assert.equal(uvNext.blocks.includes('stack/node-yarn'), true);

  let receivedDetected: unknown;
  let receivedDefault: unknown;
  const interactive = await resolveProjectPresetAndStyle({
    scope: 'project',
    prompting: true,
    hasGlobalInstall: false,
    presets,
    detection: {
      name: 'demo',
      preset: 'nextjs-app',
      packageManager: 'yarn',
      scripts: {},
      hasNx: false,
      hasPyproject: false,
      detectedBlocks: [],
      detectedSkills: [],
      detectedMcpServers: [],
      workspaces: [],
    },
    previous: {
      version: 1,
      scope: 'project',
      tools: ['claude-code'],
      blocks: [],
      skills: [],
      mcp: [],
      variables: {},
      options: { preset: 'node-tool', style: 'lean' },
      entries: [],
    },
    previousPreset: 'node-tool',
    requestedPreset: undefined,
    requestedStyle: undefined,
    prompts: {
      promptPreset: (_presets, defaultPreset, detectedPreset) => {
        receivedDefault = defaultPreset;
        receivedDetected = detectedPreset;
        return Promise.resolve('nextjs-app');
      },
      promptProjectStyle: () => Promise.resolve('self-contained'),
    },
  });
  assert.equal(receivedDefault, 'node-tool');
  assert.equal(receivedDetected, 'nextjs-app');
  assert.equal(interactive.preset, 'nextjs-app');
  assert.equal(interactive.style, 'self-contained');

  const root = await tempDir(t);
  await writeFiles(root, {
    'polyglot-poetry/package.json': JSON.stringify({
      name: 'polyglot-poetry',
      scripts: { build: 'tsc' },
    }),
    'polyglot-poetry/yarn.lock': '# yarn\n',
    'polyglot-poetry/pyproject.toml': [
      '[project]',
      'description = """',
      '[not-a-section] inside multiline string',
      '"""',
      'name = "kept-after-multiline-bracket"',
      '',
      '[tool.poetry]',
      'name = "poetry-sub"',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
      '',
    ].join('\n'),
    'polyglot-poetry/poetry.lock': '# poetry\n',
    'char-globs/package.json': JSON.stringify({
      name: 'char-globs',
      workspaces: ['packages/pkg-[ab]', 'packages/*/*', '!packages/internal-*'],
    }),
    'char-globs/packages/pkg-a/package.json': JSON.stringify({
      name: '@cg/a',
    }),
    'char-globs/packages/pkg-c/package.json': JSON.stringify({
      name: '@cg/c',
    }),
    'char-globs/packages/internal-tools/sub/package.json': JSON.stringify({
      name: '@cg/internal-sub',
    }),
  });

  const [polyglotPoetry, charGlobs] = await Promise.all([
    detectProject(join(root, 'polyglot-poetry')),
    detectProject(join(root, 'char-globs')),
  ]);

  assert.equal(polyglotPoetry.packageManager, 'yarn');
  assert.equal(polyglotPoetry.pythonPackageManager, 'poetry');
  const poetrySeed = buildProjectSeed(polyglotPoetry);
  assert.equal(
    poetrySeed.includes('- Install dependencies: `poetry install`'),
    true,
  );
  assert.equal(poetrySeed.includes('- Run tests: `poetry run pytest`'), true);
  assert.equal(poetrySeed.includes('uv sync'), false);

  assert.deepEqual(
    charGlobs.workspaces.map((ws) => ws.relativePath),
    ['packages/pkg-a'],
  );
});
