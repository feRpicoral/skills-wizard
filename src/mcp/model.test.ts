import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { McpError } from '../errors.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  appendMcpServers,
  defaultMcpServerNames,
  detectedMcpServerNames,
  formatMcpServerYaml,
  isEnvVarName,
  isMcpServerName,
  isSecretValue,
  loadMcpCatalog,
  mcpCatalogPath,
  parseMcpCatalog,
  selectMcpServers,
} from './model.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

test('loadMcpCatalog loads and validates mcp/servers.yaml with global defaults and project detections', async () => {
  const file = mcpCatalogPath(REPO_ROOT);

  const catalog = await loadMcpCatalog(file);

  assert.deepEqual(
    catalog.servers.map((server) => server.name),
    ['context7', 'fetcher', 'reddit', 'nx', 'supabase', 'sentry'],
  );
  assert.deepEqual(defaultMcpServerNames(catalog, 'global'), [
    'context7',
    'fetcher',
    'reddit',
  ]);
  assert.deepEqual(defaultMcpServerNames(catalog, 'project'), []);
  assert.deepEqual(
    detectedMcpServerNames(catalog, ['nx', 'supabase', 'sentry']),
    ['nx', 'supabase', 'sentry'],
  );
  assert.equal(isMcpServerName('context7'), true);
  assert.equal(isMcpServerName('Invalid_Name'), false);
  assert.equal(isEnvVarName('SUPABASE_ACCESS_TOKEN'), true);
  assert.equal(isEnvVarName('123-BAD'), false);
});

test('selectMcpServers filters by scope and rejects unknown or out-of-scope servers', async () => {
  const catalog = await loadMcpCatalog(mcpCatalogPath(REPO_ROOT));

  const selected = selectMcpServers({
    catalog,
    names: ['reddit', 'context7'],
    scope: 'global',
  });
  const selectUnknown = () =>
    selectMcpServers({ catalog, names: ['missing'], scope: 'global' });
  const selectOutOfScope = () =>
    selectMcpServers({ catalog, names: ['nx'], scope: 'global' });

  assert.deepEqual(
    selected.map((server) => server.name),
    ['context7', 'reddit'],
  );
  assert.throws(selectUnknown, McpError);
  assert.throws(selectOutOfScope, McpError);
});

test('parseMcpCatalog rejects duplicate names, defaults outside scopes, invalid secrets, multiline descriptions, and unsafe URLs', () => {
  const duplicateRaw = {
    servers: [
      {
        name: 'alpha',
        description: 'First',
        scopes: ['global'],
        transport: 'stdio',
        command: 'npx',
      },
      {
        name: 'alpha',
        description: 'Duplicate',
        scopes: ['global'],
        transport: 'stdio',
        command: 'npx',
      },
    ],
  };
  const badDefaultsRaw = {
    servers: [
      {
        name: 'alpha',
        description: 'First',
        scopes: ['project'],
        defaults: ['global'],
        transport: 'stdio',
        command: 'npx',
      },
    ],
  };
  const badSecretRaw = {
    servers: [
      {
        name: 'alpha',
        description: 'First',
        scopes: ['global'],
        transport: 'stdio',
        command: 'npx',
        env: { TOKEN: { secret: 'BAD-VAR}' } },
      },
    ],
  };
  const badUrlRaw = {
    servers: [
      {
        name: 'alpha',
        description: 'First',
        scopes: ['global'],
        transport: 'http',
        url: 'http://example.com/mcp',
      },
    ],
  };
  const credentialUrlRaw = {
    servers: [
      {
        name: 'alpha',
        description: 'First',
        scopes: ['global'],
        transport: 'http',
        url: 'https://user:secret@example.com/mcp',
      },
    ],
  };
  const multilineDescriptionRaw = {
    servers: [
      {
        name: 'alpha',
        description: 'Line one\nLine two',
        scopes: ['global'],
        transport: 'stdio',
        command: 'npx',
      },
    ],
  };
  const localhostHttpRaw = {
    servers: [
      {
        name: 'local-dev',
        description: 'Localhost HTTP server',
        scopes: ['project'],
        transport: 'http',
        url: 'http://127.0.0.1:8787/mcp',
      },
    ],
  };

  const runDuplicate = () => parseMcpCatalog(duplicateRaw, 'servers.yaml');
  const runBadDefaults = () => parseMcpCatalog(badDefaultsRaw, 'servers.yaml');
  const runBadSecret = () => parseMcpCatalog(badSecretRaw, 'servers.yaml');
  const runBadUrl = () => parseMcpCatalog(badUrlRaw, 'servers.yaml');
  const runCredentialUrl = () =>
    parseMcpCatalog(credentialUrlRaw, 'servers.yaml');
  const runMultiline = () =>
    parseMcpCatalog(multilineDescriptionRaw, 'servers.yaml');
  const parsedLocalhost = parseMcpCatalog(localhostHttpRaw, 'servers.yaml');

  assert.throws(runDuplicate, /listed twice/);
  assert.throws(runBadDefaults, /defaults outside its scopes/);
  assert.throws(runBadSecret, /environment variable name/);
  assert.throws(runBadUrl, /https:\/\/ URL/);
  assert.throws(runCredentialUrl, /without credentials/);
  assert.throws(runMultiline, /single line/);
  assert.equal(parsedLocalhost.servers[0]?.name, 'local-dev');
});

test('appendMcpServers preserves existing YAML comments and formatting while appending a validated server', async (t) => {
  const root = await tempDir(t);
  const file = join(root, 'servers.yaml');
  await writeFiles(root, {
    'servers.yaml': [
      '# Curated MCP catalog',
      'servers:',
      '  - name: fetcher',
      '    description: Fetcher server',
      '    scopes: [global]',
      '    defaults: [global]',
      '    transport: stdio',
      '    command: npx',
      "    args: ['-y', 'fetcher-mcp@0.2.1']",
      '',
    ].join('\n'),
  });

  const updated = await appendMcpServers(file, [
    {
      name: 'sentry',
      description: 'Sentry issue inspection',
      scopes: ['project'],
      defaults: [],
      detect: 'sentry',
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      headers: {
        Authorization: { secret: 'SENTRY_AUTH_TOKEN', optional: true },
      },
      tools: { allow: ['list-issues'] },
      estimatedTools: 14,
    },
  ]);
  const text = await readFile(file, 'utf8');
  const formatted = formatMcpServerYaml(updated.servers[1]!);

  assert.equal(updated.servers.length, 2);
  assert.equal(text.startsWith('# Curated MCP catalog\n'), true);
  assert.equal(text.includes('scopes: [project]'), true);
  assert.equal(text.includes('allow: [list-issues]'), true);
  assert.equal(formatted.includes('name: sentry'), true);
  assert.equal(
    isSecretValue(
      updated.servers[1]?.transport === 'http'
        ? updated.servers[1].headers.Authorization!
        : '',
    ),
    true,
  );
});
