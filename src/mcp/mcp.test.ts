import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { BlockLibrary } from '../blocks/library.ts';
import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import { applyPlan } from '../install/apply.ts';
import { buildPlan } from '../install/plan.ts';
import {
  globalManifestPath,
  projectManifestPath,
  readProjectManifest,
} from '../state/manifest.ts';
import { tempDir, tempPaths, writeFiles } from '../test-support/fixtures.ts';
import {
  ensureMcpJsonServers,
  MCP_TOML_MARKERS,
  removeMcpJsonServers,
  removeMcpTomlServers,
  upsertMcpTomlServers,
} from './install.ts';
import {
  loadMcpCatalog,
  type McpCatalog,
  mcpCatalogPath,
  type McpServerDefinition,
} from './model.ts';
import {
  claudeDeniedToolPermissions,
  renderMcpJsonServers,
  renderMcpTomlServers,
} from './render.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const testLibrary: BlockLibrary = {
  headers: { global: '# Rules' },
  groups: { core: 'Core' },
  blocks: [
    {
      id: 'core/style',
      group: 'core',
      title: 'Style',
      summary: 'Style',
      scopes: ['global', 'project'],
      defaults: ['global', 'project'],
      variables: [],
      requires: [],
      skills: [],
      body: '## Style\n\nBe direct.',
    },
  ],
};

test('renderMcpJsonServers formats per-tool server definitions and handles Antigravity secret rules', async () => {
  const catalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));
  const customRequiredRemote: McpServerDefinition = {
    name: 'private-http',
    description: 'Remote server with required secret header',
    scopes: ['global'],
    defaults: [],
    transport: 'http',
    url: 'https://api.example.com/mcp',
    headers: {
      'X-Api-Key': { secret: 'PRIVATE_API_KEY' },
    },
    tools: { allow: ['read-item'], deny: ['delete-item'] },
  };
  const customStdio: McpServerDefinition = {
    name: 'custom-stdio',
    description: 'Stdio server with mixed env and tool filters',
    scopes: ['global'],
    defaults: [],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'custom-mcp@1.0.0'],
    cwd: '/tmp/work',
    env: {
      API_TOKEN: { secret: 'API_TOKEN' },
      LOG_LEVEL: 'info',
    },
    tools: { allow: ['search'], deny: ['drop-table'] },
  };
  const servers = [
    ...catalog.servers.filter((s) =>
      ['context7', 'supabase', 'sentry'].includes(s.name),
    ),
    customRequiredRemote,
    customStdio,
  ];

  const agy = renderMcpJsonServers({ client: 'antigravity', servers });
  const claude = renderMcpJsonServers({ client: 'claude-code', servers });
  const gemini = renderMcpJsonServers({ client: 'gemini-cli', servers });
  const copilot = renderMcpJsonServers({ client: 'copilot', servers });
  const denied = claudeDeniedToolPermissions(servers);

  assert.equal(agy.serverNames.includes('private-http'), false);
  assert.equal(agy.warnings.length, 1);
  assert.deepEqual(agy.servers.context7, {
    url: 'https://mcp.context7.com/mcp',
    serverUrl: 'https://mcp.context7.com/mcp',
    enabledTools: ['resolve-library-id', 'get-library-docs'],
  });
  assert.deepEqual(agy.servers.supabase, {
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase@0.5.5', '--read-only'],
  });
  assert.deepEqual(agy.servers['custom-stdio'], {
    command: 'npx',
    args: ['-y', 'custom-mcp@1.0.0'],
    cwd: '/tmp/work',
    env: { LOG_LEVEL: 'info' },
    enabledTools: ['search'],
    disabledTools: ['drop-table'],
  });
  assert.deepEqual(claude.servers.sentry, {
    type: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    headers: { Authorization: 'Bearer ${SENTRY_AUTH_TOKEN}' },
  });
  assert.deepEqual(claude.servers.context7, {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
  });
  assert.deepEqual(gemini.servers.context7, {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
    includeTools: ['resolve-library-id', 'get-library-docs'],
  });
  assert.deepEqual(copilot.servers.supabase, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase@0.5.5', '--read-only'],
    env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
    tools: ['*'],
  });
  assert.deepEqual(copilot.servers.context7?.tools, [
    'resolve-library-id',
    'get-library-docs',
  ]);
  assert.deepEqual(denied, [
    'mcp__private-http__delete-item',
    'mcp__custom-stdio__drop-table',
  ]);
});

test('renderMcpTomlServers formats Codex TOML tables, escapes DEL control characters, and skips SSE servers with a warning', async () => {
  const catalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));
  const sseServer: McpServerDefinition = {
    name: 'legacy-sse',
    description: 'Legacy SSE server',
    scopes: ['global'],
    defaults: [],
    transport: 'sse',
    url: 'https://example.com/sse',
    headers: {},
  };
  const stdioWithLiteralEnv: McpServerDefinition = {
    name: 'stdio-env',
    description: 'Stdio server with literal env and tool filters',
    scopes: ['global'],
    defaults: [],
    transport: 'stdio',
    command: 'node',
    args: ['server.js', 'del-\u007f-char'],
    env: {
      SECRET_TOKEN: { secret: 'SECRET_TOKEN' },
      MODE: 'readonly',
    },
    tools: { allow: ['ping'], deny: ['exec'] },
  };
  const servers = [
    ...catalog.servers.filter((s) =>
      ['context7', 'supabase', 'sentry'].includes(s.name),
    ),
    sseServer,
    stdioWithLiteralEnv,
  ];

  const rendered = renderMcpTomlServers(servers);

  assert.deepEqual(rendered.serverNames, [
    'context7',
    'supabase',
    'sentry',
    'stdio-env',
  ]);
  assert.equal(rendered.warnings.length, 1);
  assert.match(rendered.warnings[0]!, /does not support SSE/);
  assert.match(
    rendered.body,
    /\[mcp_servers\.context7\]\nurl = "https:\/\/mcp\.context7\.com\/mcp"\nenv_http_headers = \{ CONTEXT7_API_KEY = "CONTEXT7_API_KEY" \}\nenabled_tools = \["resolve-library-id", "get-library-docs"\]/,
  );
  assert.match(
    rendered.body,
    /\[mcp_servers\.supabase\]\ncommand = "npx"\nargs = \["-y", "@supabase\/mcp-server-supabase@0\.5\.5", "--read-only"\]\nenv_vars = \["SUPABASE_ACCESS_TOKEN"\]/,
  );
  assert.match(
    rendered.body,
    /\[mcp_servers\.sentry\]\nurl = "https:\/\/mcp\.sentry\.dev\/mcp"\nbearer_token_env_var = "SENTRY_AUTH_TOKEN"/,
  );
  assert.match(
    rendered.body,
    /\[mcp_servers\.stdio-env\]\ncommand = "node"\nargs = \["server\.js", "del-\\u007f-char"\]\nenv_vars = \["SECRET_TOKEN"\]\nenabled_tools = \["ping"\]\ndisabled_tools = \["exec"\]\n\n\[mcp_servers\.stdio-env\.env\]\nMODE = "readonly"/,
  );
});

test('ensureMcpJsonServers and removeMcpJsonServers preserve existing keys, unmanaged servers, key-order invariance, BOM, and CRLF', () => {
  const existing =
    '\uFEFF{\r\n    "$schema": "https://example.com/schema.json",\r\n    "mcpServers": {\r\n        "custom": {\r\n            "command": "custom-bin"\r\n        }\r\n    }\r\n}\r\n';

  const added = ensureMcpJsonServers({
    existing,
    servers: {
      fetcher: { command: 'npx', args: ['-y', 'fetcher-mcp@0.2.1'] },
    },
    ownedServers: [],
  });
  const reorderedNoOp = ensureMcpJsonServers({
    existing: added.content,
    servers: {
      fetcher: { args: ['-y', 'fetcher-mcp@0.2.1'], command: 'npx' },
    },
    ownedServers: ['fetcher'],
  });
  const removed = removeMcpJsonServers({
    existing: added.content,
    servers: ['fetcher'],
    createdMcpServers: added.createdMcpServers,
  });
  const conflictAttempt = () =>
    ensureMcpJsonServers({
      existing,
      servers: { custom: { command: 'overwrite' } },
      ownedServers: [],
    });

  assert.equal(added.createdMcpServers, false);
  assert.equal(added.content.startsWith('\uFEFF{\r\n'), true);
  assert.equal(added.content.includes('"custom": {\r\n'), true);
  assert.equal(added.content.includes('"fetcher": {\r\n'), true);
  assert.equal(reorderedNoOp.content, added.content);
  assert.equal(removed, existing);
  assert.throws(conflictAttempt, JsonMergeError);
});

test('upsertMcpTomlServers and removeMcpTomlServers preserve outside TOML, ignore multiline string contents, and reject unmanaged server collisions', () => {
  const existing = [
    'model = "gpt-5"',
    '# [mcp_servers.context7]',
    'notes = """',
    '[mcp_servers.context7]',
    '"""',
    '',
    '[mcp_servers.custom]',
    'command = "my-mcp"',
    '',
  ].join('\n');

  const upserted = upsertMcpTomlServers({
    existing,
    body: '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"',
    serverNames: ['context7'],
  });
  const removed = removeMcpTomlServers(upserted);
  const collideBare = () =>
    upsertMcpTomlServers({
      existing,
      body: '[mcp_servers.custom]\ncommand = "other"',
      serverNames: ['custom'],
    });
  const collideQuoted = () =>
    upsertMcpTomlServers({
      existing: '[mcp_servers."custom"]\ncommand = "my-mcp"\n',
      body: '[mcp_servers.custom]\ncommand = "other"',
      serverNames: ['custom'],
    });
  const collideDotted = () =>
    upsertMcpTomlServers({
      existing: 'mcp_servers.custom.url = "https://example.com"\n',
      body: '[mcp_servers.custom]\nurl = "https://other.example.com"',
      serverNames: ['custom'],
    });
  const collideInline = () =>
    upsertMcpTomlServers({
      existing: '[mcp_servers]\ncustom = { command = "my-mcp" }\n',
      body: '[mcp_servers.custom]\ncommand = "other"',
      serverNames: ['custom'],
    });
  const collideSyntaxError = () =>
    upsertMcpTomlServers({
      existing: 'broken = [\n',
      body: '[mcp_servers.custom]\ncommand = "other"',
      serverNames: ['custom'],
    });

  assert.equal(upserted.includes(MCP_TOML_MARKERS.begin), true);
  assert.equal(upserted.includes('[mcp_servers.custom]'), true);
  assert.equal(removed, existing);
  assert.throws(collideBare, ManagedRegionError);
  assert.throws(collideQuoted, ManagedRegionError);
  assert.throws(collideDotted, ManagedRegionError);
  assert.throws(collideInline, ManagedRegionError);
  assert.throws(collideSyntaxError, ManagedRegionError);
});

test('buildPlan and applyPlan share Antigravity mcp_config.json, share project .mcp.json, and coexist in Gemini settings.json', async (t) => {
  const paths = await tempPaths(t);
  const projectDir = await realpath(await tempDir(t));
  const mcpCatalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));
  await writeFiles(projectDir, {
    '.mcp.json': JSON.stringify(
      {
        mcpServers: {
          unmanaged: { command: 'node', args: ['local.js'] },
        },
      },
      null,
      2,
    ),
  });

  const globalPlan = await buildPlan({
    scope: 'global',
    selection: {
      tools: ['antigravity', 'antigravity-cli', 'gemini-cli', 'codex'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['context7', 'fetcher'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: globalManifestPath(paths),
    mcpCatalog,
  });
  await applyPlan(globalPlan);
  const projectPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code', 'copilot', 'gemini-cli'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['nx', 'supabase'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog,
  });
  await applyPlan(projectPlan);
  const agyConfig = JSON.parse(
    await readFile(join(paths.geminiHome, 'config', 'mcp_config.json'), 'utf8'),
  ) as { mcpServers: Record<string, unknown> };
  const geminiGlobalSettings = JSON.parse(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
  ) as { context: unknown; mcpServers: Record<string, unknown> };
  const sharedProjectMcp = JSON.parse(
    await readFile(join(projectDir, '.mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, Record<string, unknown>> };
  const recordedProject = await readProjectManifest(
    projectManifestPath(projectDir),
    { dir: projectDir },
  );
  const deselectMcpPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code'],
      blocks: ['core/style'],
      skills: [],
      mcp: [],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: recordedProject?.manifest ?? null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog,
  });
  await applyPlan(deselectMcpPlan);
  const afterRemovalMcp = JSON.parse(
    await readFile(join(projectDir, '.mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, unknown> };

  assert.deepEqual(Object.keys(agyConfig.mcpServers), ['context7', 'fetcher']);
  assert.deepEqual(geminiGlobalSettings.context, {
    fileName: ['AGENTS.md', 'GEMINI.md'],
  });
  assert.deepEqual(Object.keys(geminiGlobalSettings.mcpServers), [
    'context7',
    'fetcher',
  ]);
  assert.deepEqual(Object.keys(sharedProjectMcp.mcpServers), [
    'unmanaged',
    'nx',
    'supabase',
  ]);
  assert.equal(sharedProjectMcp.mcpServers.nx?.type, 'stdio');
  assert.deepEqual(sharedProjectMcp.mcpServers.nx?.tools, ['*']);
  assert.deepEqual(Object.keys(afterRemovalMcp.mcpServers), ['unmanaged']);
});

test('buildPlan marks a conflict when an unmanaged server has the same name and never overwrites it', async (t) => {
  const paths = await tempPaths(t);
  const projectDir = await realpath(await tempDir(t));
  const mcpCatalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));
  const initialJson = JSON.stringify(
    {
      mcpServers: {
        nx: { command: 'custom-nx', args: [] },
      },
    },
    null,
    2,
  );
  const initialToml = '[mcp_servers.nx]\ncommand = "custom-nx"\n';
  await writeFiles(projectDir, {
    '.mcp.json': initialJson,
    '.codex/config.toml': initialToml,
  });

  const plan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code', 'codex'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['nx', 'supabase'],
      variables: {},
      skillMode: 'copy',
      keepLocal: false,
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog,
  });
  const outcome = await applyPlan(plan);
  const jsonAfter = await readFile(join(projectDir, '.mcp.json'), 'utf8');
  const tomlAfter = await readFile(
    join(projectDir, '.codex', 'config.toml'),
    'utf8',
  );

  assert.equal(outcome.skipped.length, 2);
  assert.equal(jsonAfter, initialJson);
  assert.equal(tomlAfter, initialToml);
});

test('buildPlan and applyPlan remove stale Claude permissions.deny entries when an MCP server is removed and restore blank co-owned Gemini settings.json', async (t) => {
  const paths = await tempPaths(t);
  const projectDir = await realpath(await tempDir(t));
  const customCatalog: McpCatalog = {
    servers: [
      {
        name: 'alpha',
        description: 'Alpha server',
        scopes: ['project'],
        defaults: [],
        transport: 'stdio',
        command: 'npx',
        args: ['alpha-mcp'],
        env: {},
        tools: { deny: ['drop-db'] },
      },
      {
        name: 'beta',
        description: 'Beta server',
        scopes: ['project'],
        defaults: [],
        transport: 'stdio',
        command: 'npx',
        args: ['beta-mcp'],
        env: {},
        tools: { deny: ['exec-shell'] },
      },
    ],
  };
  await writeFiles(projectDir, {
    '.claude/settings.json': JSON.stringify(
      { permissions: { deny: ['Bash(rm:*)'] } },
      null,
      2,
    ),
    '.gemini/settings.json': '  \n',
  });

  const installBothPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code', 'gemini-cli'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['alpha', 'beta'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog: customCatalog,
  });
  await applyPlan(installBothPlan);
  const afterBothManifest = await readProjectManifest(
    projectManifestPath(projectDir),
    { dir: projectDir },
  );
  const removeBetaPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code', 'gemini-cli'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['alpha'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: afterBothManifest?.manifest ?? null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog: customCatalog,
  });
  await applyPlan(removeBetaPlan);
  const claudeAfterRemoveBeta = JSON.parse(
    await readFile(join(projectDir, '.claude', 'settings.json'), 'utf8'),
  ) as { permissions: { deny: string[] } };
  const afterAlphaManifest = await readProjectManifest(
    projectManifestPath(projectDir),
    { dir: projectDir },
  );
  const removeAllPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: [],
      blocks: ['core/style'],
      skills: [],
      mcp: [],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: afterAlphaManifest?.manifest ?? null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog: customCatalog,
  });
  await applyPlan(removeAllPlan);
  const geminiAfterRemoveAll = await readFile(
    join(projectDir, '.gemini', 'settings.json'),
    'utf8',
  );

  assert.deepEqual(claudeAfterRemoveBeta.permissions.deny, [
    'Bash(rm:*)',
    'mcp__alpha__drop-db',
  ]);
  assert.equal(geminiAfterRemoveAll, '  \n');
});

test('buildPlan and applyPlan coalesce aliased mcp-json targets and restore non-canonical empty JSON formatting on co-owned files', async (t) => {
  const paths = await tempPaths(t);
  const projectDir = await realpath(await tempDir(t));
  const baseCatalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));
  const mcpCatalog: McpCatalog = {
    servers: [
      ...baseCatalog.servers,
      {
        name: 'private-api',
        description: 'Remote server with required secret header',
        scopes: ['project'],
        defaults: [],
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: {
          Authorization: { secret: 'PRIVATE_API_TOKEN' },
        },
      },
    ],
  };
  await writeFiles(projectDir, {
    '.mcp.json': '{ }',
    '.gemini/settings.json': '{ }',
  });
  await mkdir(join(projectDir, '.agents'), { recursive: true });
  await symlink(
    join('..', '.mcp.json'),
    join(projectDir, '.agents', 'mcp_config.json'),
  );

  const installPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['antigravity', 'claude-code', 'gemini-cli'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['nx', 'private-api'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog,
  });
  const installOutcome = await applyPlan(installPlan);
  const mcpAfterInstall = JSON.parse(
    await readFile(join(projectDir, '.mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, unknown> };
  const afterInstallManifest = await readProjectManifest(
    projectManifestPath(projectDir),
    { dir: projectDir },
  );
  const removeClaudePlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['antigravity', 'gemini-cli'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['nx', 'private-api'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: afterInstallManifest?.manifest ?? null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog,
  });
  await applyPlan(removeClaudePlan);
  const mcpAfterRemoveClaude = JSON.parse(
    await readFile(join(projectDir, '.mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, unknown> };
  const afterRemoveClaudeManifest = await readProjectManifest(
    projectManifestPath(projectDir),
    { dir: projectDir },
  );
  const removeAllPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: [],
      blocks: ['core/style'],
      skills: [],
      mcp: [],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: afterRemoveClaudeManifest?.manifest ?? null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog,
  });
  await applyPlan(removeAllPlan);
  const mcpRawAfterRemoveAll = await readFile(
    join(projectDir, '.mcp.json'),
    'utf8',
  );
  const geminiRawAfterRemoveAll = await readFile(
    join(projectDir, '.gemini', 'settings.json'),
    'utf8',
  );

  assert.equal(installOutcome.skipped.length, 0);
  assert.deepEqual(Object.keys(mcpAfterInstall.mcpServers), [
    'nx',
    'private-api',
  ]);
  assert.deepEqual(Object.keys(mcpAfterRemoveClaude.mcpServers), ['nx']);
  assert.equal(mcpRawAfterRemoveAll, '{ }');
  assert.equal(geminiRawAfterRemoveAll, '{ }');
});

test('buildPlan emits tool filter warnings, suppresses Claude permissions.deny on .mcp.json conflict, and omits unrendered servers from manifest.mcp', async (t) => {
  const paths = await tempPaths(t);
  const projectDir = await realpath(await tempDir(t));
  const customCatalog: McpCatalog = {
    servers: [
      {
        name: 'filtered',
        description: 'Server with allow and deny filters',
        scopes: ['project'],
        defaults: [],
        transport: 'stdio',
        command: 'npx',
        args: ['filtered-mcp'],
        env: {},
        tools: { allow: ['safe-read'], deny: ['dangerous-write'] },
      },
      {
        name: 'sse-only',
        description: 'SSE server unsupported by Codex',
        scopes: ['project'],
        defaults: [],
        transport: 'sse',
        url: 'https://example.com/sse',
        headers: {},
      },
    ],
  };
  await writeFiles(projectDir, {
    '.mcp.json': JSON.stringify(
      { mcpServers: { filtered: { command: 'unmanaged' } } },
      null,
      2,
    ),
  });

  const claudeCopilotPlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['claude-code', 'copilot'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['filtered'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog: customCatalog,
  });
  await applyPlan(claudeCopilotPlan);
  const claudeCopilotManifest = await readProjectManifest(
    projectManifestPath(projectDir),
    { dir: projectDir },
  );
  const codexSsePlan = await buildPlan({
    scope: 'project',
    selection: {
      tools: ['codex'],
      blocks: ['core/style'],
      skills: [],
      mcp: ['sse-only'],
      variables: {},
      keepLocal: false,
      skillMode: 'copy',
    },
    library: testLibrary,
    paths,
    repoRoot: REPO_ROOT,
    previous: null,
    manifestPath: projectManifestPath(projectDir),
    project: { dir: projectDir, title: 'app' },
    mcpCatalog: customCatalog,
  });

  assert.equal(
    claudeCopilotPlan.actions.some(
      (action) => action.label === 'Claude Code MCP tool permissions',
    ),
    false,
  );
  assert.equal(
    (claudeCopilotPlan.warnings ?? []).some((w) => w.includes('tools.allow')),
    true,
  );
  assert.equal(
    (claudeCopilotPlan.warnings ?? []).some((w) => w.includes('tools.deny')),
    true,
  );
  assert.deepEqual(claudeCopilotManifest?.manifest.mcp, []);
  assert.deepEqual(codexSsePlan.manifest.mcp, []);
});
