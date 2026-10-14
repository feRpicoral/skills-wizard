import assert from 'node:assert/strict';
import { lstat, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import type { Paths } from '../env.ts';
import { globalManifestPath } from '../state/manifest.ts';
import { tempPaths, writeFiles } from '../test-support/fixtures.ts';
import { installGlobal } from '../test-support/plan-fixtures.ts';

test('deselecting Gemini CLI restores a string context file name', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, {
    '.gemini/settings.json':
      '{\n    "context": { "fileName": "GEMINI.md" }\n}\n',
  });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    '{\n    "context": { "fileName": "GEMINI.md" }\n}\n',
  );
});

test('deselecting Gemini CLI leaves an empty settings file empty again', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { '.gemini/settings.json': '' });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    '',
  );
});

test('deselecting Gemini CLI puts back a whitespace-only settings file', async (t) => {
  const paths = await tempPaths(t);
  await writeFiles(paths.home, { '.gemini/settings.json': '  \n' });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    '  \n',
  );
});

test('deselecting Gemini CLI restores a context file name with escapes as written', async (t) => {
  const paths = await tempPaths(t);
  const settings = '{"context": {"fileName": "GEM\\u0049NI.md"}}\n';
  await writeFiles(paths.home, { '.gemini/settings.json': settings });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    settings,
  );
});

test('deselecting Gemini CLI keeps other settings and parents as written', async (t) => {
  const paths = await tempPaths(t);
  const settings =
    '{\n  "ratio": 1.0,\n  "mcpServers": { "gh": { "command": "gh", "args": ["mcp"] } },\n  "context": {}\n}\n';
  await writeFiles(paths.home, { '.gemini/settings.json': settings });
  await installGlobal(paths, ['gemini-cli', 'codex']);

  await installGlobal(paths, ['codex']);

  assert.equal(
    await readFile(join(paths.geminiHome, 'settings.json'), 'utf8'),
    settings,
  );
});

async function legacySettingsInstall(paths: Paths): Promise<string> {
  const settings = join(paths.geminiHome, 'settings.json');
  await writeFiles(paths.home, {
    '.gemini/settings.json':
      '{\n  "context": {\n    "fileName": [\n      "AGENTS.md",\n      "GEMINI.md"\n    ]\n  }\n}\n',
    [relative(paths.home, globalManifestPath(paths))]: JSON.stringify({
      version: 1,
      scope: 'global',
      tools: ['gemini-cli'],
      blocks: [],
      variables: {},
      entries: [
        {
          kind: 'json-array',
          path: settings,
          key: 'context.fileName',
          added: ['AGENTS.md', 'GEMINI.md'],
          wasString: false,
          createdFile: true,
        },
      ],
    }),
  });
  return settings;
}

test('a settings file created before parents were recorded is deleted on removal', async (t) => {
  const paths = await tempPaths(t);
  const settings = await legacySettingsInstall(paths);

  await installGlobal(paths, []);

  await assert.rejects(lstat(settings), { code: 'ENOENT' });
});

test('a sync keeps an unrecorded parent count unknown instead of guessing', async (t) => {
  const paths = await tempPaths(t);
  const settings = await legacySettingsInstall(paths);
  await installGlobal(paths, ['gemini-cli']);

  await installGlobal(paths, []);

  await assert.rejects(lstat(settings), { code: 'ENOENT' });
});

test('a settings file recreated after deletion is deleted on removal', async (t) => {
  const paths = await tempPaths(t);
  const settings = join(paths.geminiHome, 'settings.json');
  await writeFiles(paths.home, {
    '.gemini/settings.json':
      '{\n  "context": {\n    "fileName": "GEMINI.md"\n  }\n}\n',
  });
  await installGlobal(paths, ['gemini-cli']);
  await rm(settings);
  await installGlobal(paths, ['gemini-cli']);

  await installGlobal(paths, []);

  await assert.rejects(lstat(settings), { code: 'ENOENT' });
});
