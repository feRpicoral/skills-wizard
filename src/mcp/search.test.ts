import assert from 'node:assert/strict';
import { test } from 'node:test';

import { McpError } from '../errors.ts';
import { allServerSecrets, requiredServerSecrets } from './model.ts';
import { deriveShortServerName, searchMcpRegistry } from './search.ts';

test('searchMcpRegistry converts npm, pypi, and remote servers, strips unsafe flags and blocked env vars, and enforces response bounds', async () => {
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
                { type: 'named', name: '--eval=foo', value: 'process.exit(1)' },
                { type: 'named', name: 'bad flag', value: '/tmp/evil.js' },
                { type: 'positional', value: '--eval=process.exit(1)' },
                { type: 'positional', value: 'bad\u0000arg' },
                { type: 'positional', value: 'safe-positional' },
              ],
              environmentVariables: [
                { name: 'CONTEXT7_API_KEY', isSecret: true, isRequired: false },
                { name: 'NODE_OPTIONS', default: '--require /tmp/evil.js' },
                { name: 'LD_PRELOAD', default: '/tmp/evil.so' },
                { name: 'DYLD_INSERT_LIBRARIES', default: '/tmp/evil.dylib' },
                { name: 'PYTHONPATH', default: '/tmp/evil' },
                { name: 'PATH', default: '/tmp/evil-bin' },
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
  const oversizedAttempt = () =>
    searchMcpRegistry({
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
    'https://registry.modelcontextprotocol.io/v0.1/servers?search=mcp&version=latest&limit=30',
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
    'safe-positional',
  ]);
  assert.deepEqual(Object.keys(npmServer.env), ['CONTEXT7_API_KEY']);
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

test('searchMcpRegistry handles digit-leading names, package fallback, isLatest prioritization, slug disambiguation, and default optional secrets', async () => {
  const payload = {
    servers: [
      {
        server: {
          name: 'io.github.example/3d-viewer',
          description: '3D model viewer',
          remotes: [
            {
              type: 'http',
              url: 'https://example.com/3d/mcp',
              headers: [
                { name: 'Authorization', isSecret: true },
                { name: 'X-Tenant-Id' },
              ],
            },
          ],
        },
      },
      {
        server: {
          name: 'io.github.example/fallback-pkg',
          description: 'Fallback package test',
          packages: [
            {
              registryType: 'npm',
              identifier: '--invalid-pkg',
            },
            {
              registryType: 'npm',
              identifier: '@example/working',
              version: '2.0.0',
              environmentVariables: [{ name: 'OPTIONAL_UNSET_VAR' }],
            },
          ],
        },
      },
      {
        server: {
          name: 'io.github.acme/versioned-mcp',
          description: 'Old version',
          version: '1.0.0',
          packages: [
            {
              registryType: 'npm',
              identifier: '@acme/versioned-mcp',
              version: '1.0.0',
            },
          ],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': { isLatest: false },
        },
      },
      {
        server: {
          name: 'io.github.acme/versioned-mcp',
          description: 'Latest version',
          version: '2.1.0',
          packages: [
            {
              registryType: 'npm',
              identifier: '@acme/versioned-mcp',
              version: '2.1.0',
            },
          ],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': { isLatest: true },
        },
      },
      {
        server: {
          name: 'io.github.alice/postgres-mcp',
          description: 'Alice Postgres MCP',
          packages: [
            { registryType: 'npm', identifier: '@alice/postgres-mcp' },
          ],
        },
      },
      {
        server: {
          name: 'io.github.bob/postgres-mcp',
          description: 'Bob Postgres MCP',
          packages: [{ registryType: 'npm', identifier: '@bob/postgres-mcp' }],
        },
      },
    ],
  };

  const candidates = await searchMcpRegistry({
    query: 'mcp',
    limit: 10,
    fetchFn: () =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
  const viewer = candidates.find((c) => c.name === '3d-viewer');
  const fallback = candidates.find((c) => c.name === 'fallback-pkg');
  const versioned = candidates.find((c) => c.name === 'versioned-mcp');
  const alicePg = candidates.find(
    (c) => c.fullName === 'io.github.alice/postgres-mcp',
  );
  const bobPg = candidates.find(
    (c) => c.fullName === 'io.github.bob/postgres-mcp',
  );

  assert.ok(viewer);
  assert.deepEqual(allServerSecrets(viewer.server), [
    'MCP_3D_VIEWER_AUTH_TOKEN',
    'X_TENANT_ID',
  ]);
  assert.deepEqual(requiredServerSecrets(viewer.server), []);
  assert.ok(fallback);
  assert.equal(fallback.server.transport, 'stdio');
  assert.deepEqual(fallback.server.args, ['-y', '@example/working@2.0.0']);
  assert.deepEqual(requiredServerSecrets(fallback.server), []);
  assert.deepEqual(allServerSecrets(fallback.server), ['OPTIONAL_UNSET_VAR']);
  assert.equal(versioned?.version, '2.1.0');
  assert.equal(alicePg?.name, 'postgres-mcp');
  assert.equal(bobPg?.name, 'bob-postgres-mcp');
});
