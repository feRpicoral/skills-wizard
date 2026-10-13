import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadBlockLibrary } from '../blocks/library.ts';
import { PresetError } from '../errors.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { detectProject } from './detect.ts';
import {
  findPreset,
  isPresetId,
  isProjectStyle,
  loadPresets,
  PRESET_IDS,
  presetsPath,
  resolvePresetSelection,
} from './presets.ts';
import { buildProjectSeed } from './seed.ts';

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

test('resolvePresetSelection returns only stack blocks in lean style and includes core/git/engineering blocks in self-contained style', async () => {
  const blockLibrary = await loadBlockLibrary(join(REPO_ROOT, 'blocks'));
  const skillLibrary = await loadSkillLibrary(REPO_ROOT);
  const presets = await loadPresets(presetsPath(REPO_ROOT), {
    blockLibrary,
    skillLibrary,
  });
  const nestPreset = findPreset(presets, 'nestjs-api');

  const lean = resolvePresetSelection({
    preset: nestPreset,
    style: 'lean',
    blockLibrary,
    skillLibrary,
    detectedBlocks: ['stack/supabase-prisma'],
    detectedSkills: ['supabase-prisma'],
  });
  const selfContained = resolvePresetSelection({
    preset: nestPreset,
    style: 'self-contained',
    blockLibrary,
    skillLibrary,
  });

  assert.deepEqual(lean.blocks, [
    'stack/typescript',
    'stack/node-yarn',
    'stack/lint-format',
    'stack/nestjs',
    'stack/prisma',
    'stack/supabase-prisma',
  ]);
  assert.deepEqual(lean.skills, [
    'nestjs-module',
    'eslint-configuration',
    'prettier-configuration',
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
      '[project]\nname = "worker"\ndescription = "Job worker"\n',
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
});

test('detectProject unions workspace stacks in nx-monorepo and detects additive libraries', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'nx.json': '{}\n',
    '.nvmrc': '24\n',
    'package.json': JSON.stringify({
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
    'apps/web/package.json': JSON.stringify({
      name: '@acme/web',
      description: 'Customer web dashboard',
      dependencies: {
        next: '15.0.0',
        react: '19.0.0',
        ai: '4.0.0',
        '@tanstack/react-query': '5.0.0',
      },
    }),
    'apps/api/package.json': JSON.stringify({
      name: '@acme/api',
      description: 'Core NestJS API',
      dependencies: {
        '@nestjs/core': '11.0.0',
        '@prisma/client': '6.0.0',
        '@supabase/supabase-js': '2.0.0',
        '@anthropic-ai/sdk': '0.36.0',
      },
    }),
  });

  const detection = await detectProject(root);

  assert.equal(detection.preset, 'nx-monorepo');
  assert.equal(detection.nvmrc, '24');
  assert.equal(detection.workspaces.length, 2);
  assert.equal(detection.detectedBlocks.includes('stack/nextjs'), true);
  assert.equal(detection.detectedBlocks.includes('stack/nestjs'), true);
  assert.equal(detection.detectedBlocks.includes('stack/prisma'), true);
  assert.equal(
    detection.detectedBlocks.includes('stack/supabase-prisma'),
    true,
  );
  assert.equal(detection.detectedBlocks.includes('stack/llm-apps'), true);
  assert.equal(detection.detectedSkills.includes('nestjs-module'), true);
  assert.equal(detection.detectedSkills.includes('supabase-prisma'), true);
  assert.equal(detection.detectedSkills.includes('ai-sdk'), true);
  assert.equal(detection.detectedSkills.includes('claude-api'), true);
  assert.equal(detection.detectedSkills.includes('playwright-cli'), true);
});

test('detectProject ignores symlinks that escape the project directory', async (t) => {
  const outer = await tempDir(t);
  const projectDir = join(outer, 'project');
  await writeFiles(outer, {
    'outside.json': JSON.stringify({
      name: 'escaped',
      dependencies: { next: '15.0.0' },
    }),
    'project/README.md': '# Safe\n',
  });
  await symlink(join(outer, 'outside.json'), join(projectDir, 'package.json'));

  const detection = await detectProject(projectDir);

  assert.equal(detection.name, 'project');
  assert.equal(detection.preset, undefined);
});

test('buildProjectSeed renders minimal title when no metadata exists and full sections when commands and workspaces exist', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'minimal/package.json': JSON.stringify({ name: 'tiny-pkg' }),
    'rich/.nvmrc': '24\n',
    'rich/package.json': JSON.stringify({
      name: 'acme-monorepo',
      description: 'Multi-package workspace for Acme.',
      packageManager: 'yarn@4.12.0',
      scripts: {
        test: 'vitest run',
        dev: 'nx serve web',
        lint: 'eslint .',
        postinstall: 'husky',
      },
    }),
    'rich/apps/web/package.json': JSON.stringify({
      name: '@acme/web',
      description: 'Next.js storefront',
    }),
  });

  const minimalDetection = await detectProject(join(root, 'minimal'));
  const richDetection = await detectProject(join(root, 'rich'));
  const minimalSeed = buildProjectSeed(minimalDetection);
  const richSeed = buildProjectSeed(richDetection);

  assert.equal(minimalSeed, '# tiny-pkg');
  assert.equal(richSeed.includes('# acme-monorepo'), true);
  assert.equal(richSeed.includes('Multi-package workspace for Acme.'), true);
  assert.equal(
    richSeed.includes('- Setup: `nvm use && corepack enable && yarn install`'),
    true,
  );
  assert.equal(richSeed.includes('- `yarn dev`: `nx serve web`'), true);
  assert.equal(richSeed.includes('- `yarn lint`: `eslint .`'), true);
  assert.equal(richSeed.includes('- `yarn test`: `vitest run`'), true);
  assert.equal(richSeed.includes('postinstall'), false);
  assert.equal(
    richSeed.includes('- `apps/web` (`@acme/web`): Next.js storefront'),
    true,
  );
});
