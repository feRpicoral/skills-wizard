import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import type { BlockLibrary } from '../blocks/library.ts';
import { JsonMergeError, ManagedRegionError, McpError } from '../errors.ts';
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
  allServerSecrets,
  loadMcpCatalog,
  type McpCatalog,
  mcpCatalogPath,
  type McpServerDefinition,
  requiredServerSecrets,
} from './model.ts';
import {
  claudeDeniedToolPermissions,
  renderMcpJsonServers,
  renderMcpTomlServers,
} from './render.ts';
import { deriveShortServerName, searchMcpRegistry } from './search.ts';

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

test('renderMcpTomlServers formats Codex TOML tables and skips SSE servers with a warning', async () => {
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
    args: ['server.js'],
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
    /\[mcp_servers\.stdio-env\]\ncommand = "node"\nargs = \["server\.js"\]\nenv_vars = \["SECRET_TOKEN"\]\nenabled_tools = \["ping"\]\ndisabled_tools = \["exec"\]\n\n\[mcp_servers\.stdio-env\.env\]\nMODE = "readonly"/,
  );
});

test('ensureMcpJsonServers and removeMcpJsonServers preserve existing keys, unmanaged servers, BOM, and CRLF', () => {
  const existing =
    '\uFEFF{\r\n    "$schema": "https://example.com/schema.json",\r\n    "mcpServers": {\r\n        "custom": {\r\n            "command": "custom-bin"\r\n        }\r\n    }\r\n}\r\n';

  const added = ensureMcpJsonServers({
    existing,
    servers: {
      fetcher: { command: 'npx', args: ['-y', 'fetcher-mcp@0.2.1'] },
    },
    ownedServers: [],
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
  assert.equal(removed, existing);
  assert.throws(conflictAttempt, JsonMergeError);
});

test('upsertMcpTomlServers and removeMcpTomlServers preserve outside TOML and reject unmanaged server collisions', () => {
  const existing = [
    'model = "gpt-5"',
    '# [mcp_servers.context7]',
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

  assert.equal(upserted.includes(MCP_TOML_MARKERS.begin), true);
  assert.equal(upserted.includes('[mcp_servers.custom]'), true);
  assert.equal(removed, existing);
  assert.throws(collideBare, ManagedRegionError);
  assert.throws(collideQuoted, ManagedRegionError);
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
      linkCommand: false,
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
      linkCommand: false,
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
      linkCommand: false,
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
      linkCommand: false,
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
      linkCommand: false,
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
      linkCommand: false,
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
      linkCommand: false,
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

test('searchMcpRegistry converts npm, pypi, and remote servers and enforces response bounds', async () => {
  const requestedUrls: string[] = [];
  const payload = {
    servers: [
      {
        server: {
          name: 'io.github.upstash/context7-mcp',
          description: 'Upstash Context7\nserver\twith   newlines',
          version: '1.2.0',
          packages: [
            {
              registryType: 'npm',
              identifier: '--eval=malicious',
            },
            {
              registryType: 'npm',
              identifier: '@upstash/context7-mcp',
              packageArguments: [
                { type: 'named', name: 'transport', default: 'stdio' },
                { type: 'positional', value: 'bad\u0000arg' },
              ],
              environmentVariables: [
                { name: 'CONTEXT7_API_KEY', isSecret: true, isRequired: false },
              ],
            },
          ],
        },
      },
      {
        server: {
          name: 'io.github.example/py-inspector',
          description: 'Python MCP inspector',
          version: '0.4.0',
          packages: [
            {
              registryType: 'pypi',
              identifier: 'mcp-py-inspector',
              environmentVariables: [
                { name: 'INSPECTOR_MODE', default: 'fast' },
              ],
            },
          ],
        },
      },
      {
        name: 'com.sentry/sentry-mcp',
        description: 'Sentry remote MCP server',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.sentry.dev/mcp',
            headers: [
              { name: 'Authorization', isSecret: true, isRequired: true },
            ],
          },
        ],
      },
    ],
  };

  const candidates = await searchMcpRegistry({
    query: 'mcp',
    official: true,
    limit: 5,
    fetchFn: (input) => {
      requestedUrls.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      );
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
  const npmServer = candidates[0]?.server;
  const pypiServer = candidates[1]?.server;
  const remoteServer = candidates[2]?.server;
  const oversizedAttempt = searchMcpRegistry({
    query: 'huge',
    fetchFn: () =>
      Promise.resolve(
        new Response('{"servers":[]}', {
          status: 200,
          headers: { 'content-length': String(10 * 1024 * 1024) },
        }),
      ),
  });

  assert.equal(
    requestedUrls[0],
    'https://registry.modelcontextprotocol.io/v0.1/servers?search=mcp&version=latest&limit=5',
  );
  assert.equal(
    deriveShortServerName('io.github.upstash/@context7_mcp'),
    'context7-mcp',
  );
  assert.equal(candidates.length, 3);
  assert.ok(npmServer);
  assert.equal(npmServer.description, 'Upstash Context7 server with newlines');
  assert.equal(npmServer.transport, 'stdio');
  assert.deepEqual(npmServer.args, [
    '-y',
    '@upstash/context7-mcp@1.2.0',
    '--transport',
    'stdio',
  ]);
  assert.deepEqual(requiredServerSecrets(npmServer), []);
  assert.deepEqual(allServerSecrets(npmServer), ['CONTEXT7_API_KEY']);
  assert.equal(pypiServer?.transport, 'stdio');
  assert.equal(pypiServer?.command, 'uvx');
  assert.ok(remoteServer);
  assert.equal(remoteServer.transport, 'http');
  assert.deepEqual(requiredServerSecrets(remoteServer), [
    'SENTRY_MCP_AUTH_TOKEN',
  ]);
  await assert.rejects(oversizedAttempt, McpError);
});
