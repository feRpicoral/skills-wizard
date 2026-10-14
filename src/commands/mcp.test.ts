import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { type Context, createContext } from '../context.ts';
import { ManifestError, UsageError } from '../errors.ts';
import { loadMcpCatalog, mcpCatalogPath } from '../mcp/model.ts';
import { globalManifestPath, readManifest } from '../state/manifest.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { createUpstream, isolatedGitEnv } from '../test-support/git.ts';
import { runAdopt } from './adopt.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { runMcp } from './mcp.ts';
import { runUpdate } from './update.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

interface TestContextOptions {
  url?: (repo: string) => string;
}

async function testContext(
  t: TestContext,
  { url }: TestContextOptions = {},
): Promise<{ ctx: Context; repoRoot: string; output: string[] }> {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  await writeFiles(repoRoot, {
    'blocks/index.yaml': [
      'headers:',
      '  global: "# Instructions"',
      'groups:',
      '  core: Core',
      'order:',
      '  - core/identity',
      '',
    ].join('\n'),
    'blocks/core/identity.md': [
      '---',
      'title: Identity',
      'summary: Core identity',
      'group: core',
      'scopes: [global, project]',
      'defaults: [global, project]',
      '---',
      '',
      'Follow the rules.',
      '',
    ].join('\n'),
    'catalog.yaml': [
      'categories:',
      '  diagrams: Diagrams',
      '  workflow: Workflow',
      'skills:',
      '  - name: pretty-mermaid',
      '    repo: owner/mermaid',
      '    path: .',
      '    category: diagrams',
      '    scopes: [global, project]',
      '    defaults: [global]',
      '',
    ].join('\n'),
    'mcp/servers.yaml': 'servers: []\n',
  });
  const output: string[] = [];
  const ctx: Context = {
    paths,
    repoRoot,
    cwd: repoRoot,
    searchPath: [],
    interactive: false,
    sources: {
      url: url ?? (() => 'file:///nowhere.git'),
      env: isolatedGitEnv(paths.home),
      now: () => new Date('2026-01-02T03:04:05Z'),
    },
    print: (line = '') => {
      output.push(line);
    },
  };
  return { ctx, repoRoot, output };
}

test('runMcp lists, adds, removes, and searches MCP servers and preserves MCP across update and adopt', async (t) => {
  const upstream = await createUpstream(t, {
    'SKILL.md': skillSource('pretty-mermaid'),
  });
  const { ctx, repoRoot, output } = await testContext(t, {
    url: () => upstream.url,
  });
  await writeFiles(repoRoot, {
    'mcp/servers.yaml': await readFile(mcpCatalogPath(REPO_ROOT), 'utf8'),
  });
  ctx.sources.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'io.github.example/memory-mcp',
                description: 'In-memory graph MCP server',
                version: '0.6.2',
                packages: [
                  {
                    registryType: 'npm',
                    identifier: '@modelcontextprotocol/server-memory',
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  await runInit(ctx, {
    scope: 'global',
    tools: ['claude-code', 'codex'],
    blocks: ['core/identity'],
    skills: ['pretty-mermaid'],
    mcp: ['context7'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await writeFiles(ctx.paths.home, {
    '.agents/skills/adopt-me/SKILL.md': skillSource('adopt-me'),
    '.agents/.skill-lock.json': JSON.stringify({
      version: 3,
      skills: {
        'adopt-me': {
          source: 'owner/mermaid',
          sourceType: 'github',
          skillPath: 'SKILL.md',
        },
      },
    }),
  });

  const addCode = await runMcp(ctx, {
    subcommand: 'add',
    args: ['fetcher'],
    scope: 'global',
    yes: true,
    dryRun: false,
  });
  const listCode = await runMcp(ctx, {
    subcommand: 'list',
    args: [],
    scope: 'global',
    yes: false,
    dryRun: false,
  });
  const updateCode = await runUpdate(ctx, { yes: true, dryRun: false });
  const adoptCode = await runAdopt(ctx, {
    names: ['adopt-me'],
    yes: true,
    dryRun: false,
  });
  const removeCode = await runMcp(ctx, {
    subcommand: 'remove',
    args: ['context7'],
    scope: 'global',
    yes: true,
    dryRun: false,
  });
  const searchDryRunCode = await runMcp(ctx, {
    subcommand: 'search',
    args: ['memory'],
    add: true,
    yes: true,
    dryRun: true,
  });
  const catalogAfterDryRun = await loadMcpCatalog(mcpCatalogPath(repoRoot));
  const searchAddCode = await runMcp(ctx, {
    subcommand: 'search',
    args: ['memory'],
    add: true,
    yes: true,
    dryRun: false,
  });
  const catalogAfterAdd = await loadMcpCatalog(mcpCatalogPath(repoRoot));
  const manifest = await readManifest(globalManifestPath(ctx.paths));
  const duplicateSearchAdd = () =>
    runMcp(ctx, {
      subcommand: 'search',
      args: ['memory'],
      add: true,
      yes: true,
      dryRun: false,
    });

  assert.equal(addCode, 0);
  assert.equal(listCode, 0);
  assert.equal(updateCode, 0);
  assert.equal(adoptCode, 0);
  assert.equal(removeCode, 0);
  assert.equal(searchDryRunCode, 0);
  assert.equal(
    catalogAfterDryRun.servers.some((s) => s.name === 'memory-mcp'),
    false,
  );
  assert.equal(searchAddCode, 0);
  await assert.rejects(duplicateSearchAdd, UsageError);
  assert.equal(
    catalogAfterAdd.servers.some((s) => s.name === 'memory-mcp'),
    true,
  );
  assert.deepEqual(manifest?.mcp, ['fetcher']);
  assert.match(output.join('\n'), /context7\s+\[installed\]/);
});

test('runMcp merges --tools into existing tools and preserves manifest.mcp when mcp remove conflicts', async (t) => {
  const { ctx, repoRoot } = await testContext(t);
  const project = await realpath(await tempDir(t));
  await writeFiles(repoRoot, {
    'mcp/servers.yaml': await readFile(mcpCatalogPath(REPO_ROOT), 'utf8'),
  });
  await runInit(ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['claude-code'],
    blocks: ['core/identity'],
    skills: [],
    mcp: ['nx'],
    variables: {},
    yes: true,
    dryRun: false,
  });

  const addWithToolsCode = await runMcp(ctx, {
    subcommand: 'add',
    args: ['supabase'],
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    yes: true,
    dryRun: false,
  });
  const manifestAfterAdd = await readManifest(
    join(project, '.agents', 'skills-wizard.json'),
  );
  await writeFile(join(project, '.mcp.json'), '{ invalid json');
  await writeFile(
    join(project, '.codex', 'config.toml'),
    '# BEGIN:skills-wizard-mcp\nbroken\n',
  );
  const conflictedRemoveCode = await runMcp(ctx, {
    subcommand: 'remove',
    args: ['supabase'],
    scope: 'project',
    projectDir: project,
    yes: true,
    dryRun: false,
  });
  const manifestAfterConflict = await readManifest(
    join(project, '.agents', 'skills-wizard.json'),
  );

  assert.equal(addWithToolsCode, 0);
  assert.deepEqual(manifestAfterAdd?.tools, ['claude-code', 'codex']);
  assert.deepEqual(manifestAfterAdd?.mcp, ['nx', 'supabase']);
  assert.equal(conflictedRemoveCode, 1);
  assert.deepEqual(manifestAfterConflict?.mcp, ['nx', 'supabase']);
});

test('runDoctor reports missing MCP secrets, Antigravity stdio notes, project trust notes, Gemini tool counts, and tampered MCP manifest paths', async (t) => {
  const { ctx, repoRoot, output } = await testContext(t);
  const project = await realpath(await tempDir(t));
  await writeFiles(repoRoot, {
    'mcp/servers.yaml': await readFile(mcpCatalogPath(REPO_ROOT), 'utf8'),
  });
  ctx.hasEnvVar = (name) => name === 'SENTRY_AUTH_TOKEN';
  await runInit(ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['antigravity-cli', 'claude-code', 'codex', 'gemini-cli'],
    blocks: ['core/identity'],
    skills: [],
    mcp: ['supabase', 'sentry'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  const projectManifestFile = join(project, '.agents', 'skills-wizard.json');
  const rawManifest = JSON.parse(
    await readFile(projectManifestFile, 'utf8'),
  ) as {
    mcp: string[];
    entries: { kind: string; path: string; servers?: string[] }[];
  };
  rawManifest.mcp.push('retired-mcp', 'fetcher');
  await writeFile(projectManifestFile, JSON.stringify(rawManifest, null, 2));

  const doctorCode = await runDoctor(ctx, {
    scope: 'project',
    projectDir: project,
  });
  const doctorOutput = output.join('\n');
  rawManifest.entries.push({
    kind: 'mcp-json',
    path: 'evil.json',
    servers: ['supabase'],
  });
  await writeFile(projectManifestFile, JSON.stringify(rawManifest, null, 2));
  const tamperedAttempt = runDoctor(ctx, {
    scope: 'project',
    projectDir: project,
  });
  const liveCtx = createContext({
    repoRoot,
    cwd: project,
    interactive: false,
  });
  liveCtx.sources.env = { CUSTOM_TEST_SECRET: 'set-value' };

  assert.equal(liveCtx.hasEnvVar?.('CUSTOM_TEST_SECRET'), true);
  assert.equal(liveCtx.hasEnvVar?.('MISSING_TEST_SECRET'), false);
  assert.equal(doctorCode, 0);
  assert.match(
    doctorOutput,
    /MCP server "supabase" requires unset environment variable: SUPABASE_ACCESS_TOKEN/,
  );
  assert.doesNotMatch(doctorOutput, /SENTRY_AUTH_TOKEN/);
  assert.match(
    doctorOutput,
    /Antigravity stdio MCP server \(supabase\) read secret environment variables/,
  );
  assert.match(
    doctorOutput,
    /Claude Code requires interactive project approval before loading MCP servers from \.mcp\.json/,
  );
  assert.match(
    doctorOutput,
    /Codex loads project \.codex\/config\.toml MCP servers only after the project is marked trusted/,
  );
  assert.match(
    doctorOutput,
    /Gemini CLI loads project \.gemini\/settings\.json MCP servers only in trusted folders/,
  );
  assert.match(
    doctorOutput,
    /Gemini CLI loads all MCP tool schemas into context up front \(~32 estimated tools across 2 servers\)/,
  );
  assert.match(
    doctorOutput,
    /MCP servers no longer in mcp\/servers\.yaml: retired-mcp/,
  );
  assert.match(
    doctorOutput,
    /MCP servers no longer available for project scope: fetcher/,
  );
  await assert.rejects(tamperedAttempt, ManifestError);
});

test('runMcp list surfaces corrupt manifest errors rather than swallowing them', async (t) => {
  const { ctx, repoRoot } = await testContext(t);
  await writeFiles(repoRoot, {
    'mcp/servers.yaml': await readFile(mcpCatalogPath(REPO_ROOT), 'utf8'),
  });
  await writeFiles(ctx.paths.stateDir, {
    'manifest.json': '{ invalid json',
  });

  await assert.rejects(
    runMcp(ctx, {
      subcommand: 'list',
      args: [],
      scope: 'global',
      yes: false,
      dryRun: false,
    }),
    ManifestError,
  );
});

test('runDoctor omits ~0 estimated tools when Gemini CLI MCP servers lack estimatedTools', async (t) => {
  const { ctx, repoRoot, output } = await testContext(t);
  await writeFiles(repoRoot, {
    'mcp/servers.yaml': [
      'servers:',
      '  - name: custom-unestimated',
      '    description: Custom server without estimatedTools',
      '    scopes: [global]',
      '    defaults: []',
      '    transport: stdio',
      '    command: npx',
      '    args: ["-y", "@example/unestimated@1.0.0"]',
      '',
    ].join('\n'),
  });
  await runInit(ctx, {
    scope: 'global',
    tools: ['gemini-cli'],
    blocks: ['core/identity'],
    skills: [],
    mcp: ['custom-unestimated'],
    variables: {},
    yes: true,
    dryRun: false,
  });

  const code = await runDoctor(ctx, { scope: 'global' });
  const printed = output.join('\n');

  assert.equal(code, 0);
  assert.match(
    printed,
    /Gemini CLI loads all MCP tool schemas into context up front \(1 server\)/,
  );
  assert.doesNotMatch(printed, /~0 estimated tools/);
});

test('runMcp add preserves existing Claude permissions.deny rules when .mcp.json conflicts on a newly added server', async (t) => {
  const { ctx, repoRoot } = await testContext(t);
  const project = await realpath(await tempDir(t));
  await writeFiles(repoRoot, {
    'mcp/servers.yaml': [
      'servers:',
      '  - name: alpha',
      '    description: Alpha server with denied tool',
      '    scopes: [project]',
      '    defaults: []',
      '    transport: stdio',
      '    command: npx',
      '    args: ["-y", "alpha-mcp@1.0.0"]',
      '    tools:',
      '      deny: [drop-db]',
      '  - name: beta',
      '    description: Beta server with denied tool',
      '    scopes: [project]',
      '    defaults: []',
      '    transport: stdio',
      '    command: npx',
      '    args: ["-y", "beta-mcp@1.0.0"]',
      '    tools:',
      '      deny: [exec-shell]',
      '',
    ].join('\n'),
  });
  await runInit(ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['claude-code'],
    blocks: ['core/identity'],
    skills: [],
    mcp: ['alpha'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await writeFile(
    join(project, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          alpha: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'alpha-mcp@1.0.0'],
          },
          beta: {
            command: 'unmanaged-beta',
          },
        },
      },
      null,
      2,
    ),
  );

  const code = await runMcp(ctx, {
    subcommand: 'add',
    args: ['beta'],
    scope: 'project',
    projectDir: project,
    yes: true,
    dryRun: false,
  });
  const claudeSettings = JSON.parse(
    await readFile(join(project, '.claude', 'settings.json'), 'utf8'),
  ) as { permissions?: { deny?: string[] } };

  assert.equal(code, 1);
  assert.deepEqual(claudeSettings.permissions?.deny, ['mcp__alpha__drop-db']);
});
