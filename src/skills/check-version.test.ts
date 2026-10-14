import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');

const eslintScript = join(
  repoRoot,
  'skills',
  'eslint-configuration',
  'scripts',
  'check-version.mjs',
);
const prettierScript = join(
  repoRoot,
  'skills',
  'prettier-configuration',
  'scripts',
  'check-version.mjs',
);

async function runCheckVersion(
  scriptPath: string,
  projectDir: string,
): Promise<{
  message: string;
  result: Record<string, unknown>;
}> {
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath,
    projectDir,
  ]);
  const lines = stdout.trim().split('\n');
  const jsonLine = lines.at(-1) ?? '{}';
  return {
    message: lines.slice(0, -1).join('\n'),
    result: JSON.parse(jsonLine) as Record<string, unknown>,
  };
}

test('check-version.mjs stops at project boundary unless inside a workspace root and reports installedFrom', async (t) => {
  const outer = await tempDir(t);
  await writeFiles(outer, {
    'node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '8.57.0',
    }),
    'node_modules/prettier/package.json': JSON.stringify({
      name: 'prettier',
      version: '2.8.8',
    }),
    'standalone/package.json': JSON.stringify({ name: 'standalone' }),
    'monorepo/package.json': JSON.stringify({
      name: 'monorepo',
      workspaces: ['packages/*'],
    }),
    'monorepo/node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '10.12.0',
    }),
    'monorepo/packages/app/package.json': JSON.stringify({
      name: '@monorepo/app',
    }),
  });

  const standaloneEslint = await runCheckVersion(
    eslintScript,
    join(outer, 'standalone'),
  );
  const standalonePrettier = await runCheckVersion(
    prettierScript,
    join(outer, 'standalone'),
  );
  const workspaceEslint = await runCheckVersion(
    eslintScript,
    join(outer, 'monorepo', 'packages', 'app'),
  );

  assert.equal(standaloneEslint.result['status'], 'missing');
  assert.equal(standaloneEslint.result['installedVersion'], null);
  assert.equal(standaloneEslint.result['installedFrom'], null);
  assert.equal(standalonePrettier.result['status'], 'missing');
  assert.equal(standalonePrettier.result['installedFrom'], null);
  assert.equal(workspaceEslint.result['status'], 'match');
  assert.equal(workspaceEslint.result['installedVersion'], '10.12.0');
  assert.equal(
    workspaceEslint.result['installedFrom'],
    join(outer, 'monorepo'),
  );
});

test('check-version.mjs handles npm aliases, uncomparable ranges (declared), and upper-bound stale installs', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'alias-pkg/package.json': JSON.stringify({
      name: 'alias-pkg',
      devDependencies: { eslint: 'npm:eslint-v1@9.22.0' },
    }),
    'catalog-pkg/package.json': JSON.stringify({
      name: 'catalog-pkg',
      devDependencies: {
        eslint: 'catalog:',
        prettier: 'workspace:*',
      },
    }),
    'upper-stale/package.json': JSON.stringify({
      name: 'upper-stale',
      devDependencies: {
        eslint: '^9.0.0',
        prettier: '~3.8.0',
      },
    }),
    'upper-stale/node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '10.12.0',
    }),
    'upper-stale/node_modules/prettier/package.json': JSON.stringify({
      name: 'prettier',
      version: '3.9.10',
    }),
  });

  const aliasRes = await runCheckVersion(eslintScript, join(root, 'alias-pkg'));
  const catalogEslint = await runCheckVersion(
    eslintScript,
    join(root, 'catalog-pkg'),
  );
  const catalogPrettier = await runCheckVersion(
    prettierScript,
    join(root, 'catalog-pkg'),
  );
  const upperEslint = await runCheckVersion(
    eslintScript,
    join(root, 'upper-stale'),
  );
  const upperPrettier = await runCheckVersion(
    prettierScript,
    join(root, 'upper-stale'),
  );

  assert.equal(aliasRes.result['status'], 'older');
  assert.match(aliasRes.message, /lower bound 9\.22\.0/);

  assert.equal(catalogEslint.result['status'], 'declared');
  assert.equal(catalogEslint.result['action'], 'install-and-recheck');
  assert.equal(catalogPrettier.result['status'], 'declared');
  assert.equal(catalogPrettier.result['action'], 'install-and-recheck');

  assert.equal(upperEslint.result['staleInstall'], true);
  assert.match(upperEslint.message, /outside the range/);
  assert.equal(upperPrettier.result['staleInstall'], true);
  assert.match(upperPrettier.message, /outside the range/);
});

test('check-version.mjs scripts are byte-for-byte identical and handle git ceiling, union/tilde/url ranges, and prereleases', async (t) => {
  const [eslintSource, prettierSource] = await Promise.all([
    readFile(eslintScript, 'utf8'),
    readFile(prettierScript, 'utf8'),
  ]);
  assert.equal(eslintSource, prettierSource);

  const outer = await tempDir(t);
  await mkdir(join(outer, '.git'));
  await writeFiles(outer, {
    'node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '8.57.0',
    }),
    'subproject/package.json': JSON.stringify({
      name: 'subproject',
    }),
    'union-pkg/package.json': JSON.stringify({
      name: 'union-pkg',
      devDependencies: {
        eslint: '^9.0.0 || ^10.0.0',
      },
    }),
    'union-pkg/node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '10.12.0',
    }),
    'tilde-major/package.json': JSON.stringify({
      name: 'tilde-major',
      devDependencies: {
        eslint: '~10',
      },
    }),
    'tilde-major/node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '10.12.0',
    }),
    'prerelease-pkg/package.json': JSON.stringify({
      name: 'prerelease-pkg',
      devDependencies: {
        eslint: '^10.12.0-beta.1',
      },
    }),
    'prerelease-pkg/node_modules/eslint/package.json': JSON.stringify({
      name: 'eslint',
      version: '10.12.0-beta.1',
    }),
    'url-pkg/package.json': JSON.stringify({
      name: 'url-pkg',
      devDependencies: {
        eslint: 'https://github.com/eslint/eslint/tarball/v9.0.0',
      },
    }),
  });

  const [subproject, unionPkg, tildeMajor, prereleasePkg, urlPkg] =
    await Promise.all([
      runCheckVersion(eslintScript, join(outer, 'subproject')),
      runCheckVersion(eslintScript, join(outer, 'union-pkg')),
      runCheckVersion(eslintScript, join(outer, 'tilde-major')),
      runCheckVersion(eslintScript, join(outer, 'prerelease-pkg')),
      runCheckVersion(eslintScript, join(outer, 'url-pkg')),
    ]);

  assert.equal(subproject.result['status'], 'missing');
  assert.equal(unionPkg.result['status'], 'match');
  assert.equal(unionPkg.result['staleInstall'], false);
  assert.equal(tildeMajor.result['status'], 'match');
  assert.equal(tildeMajor.result['staleInstall'], false);
  assert.equal(prereleasePkg.result['status'], 'older');
  assert.equal(prereleasePkg.result['staleInstall'], false);
  assert.equal(urlPkg.result['status'], 'declared');
});
