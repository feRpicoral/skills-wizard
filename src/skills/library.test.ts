import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { skillSource, tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  defaultSkillNames,
  loadSkillLibrary,
  unknownSkillNames,
} from './library.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

const CATALOG = [
  'categories:',
  '  docs: Docs',
  'skills:',
  '  - name: mermaid',
  '    repo: owner/repo',
  '    path: .',
  '    category: docs',
  '    scopes: [global, project]',
  '    defaults: [global]',
  '',
].join('\n');

test('the repository library preselects its default global skills', async () => {
  const library = await loadSkillLibrary(REPO_ROOT);

  const defaults = defaultSkillNames(library, 'global');

  assert.deepEqual(defaults, [
    'github-repo-setup',
    'pretty-mermaid',
    'skill-scanner',
  ]);
});

test('lists first-party skills before catalog skills', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'catalog.yaml': CATALOG,
    'skills/notes/SKILL.md': skillSource('notes'),
    'skills/drafts/README.md': '# Not a skill yet\n',
  });

  const library = await loadSkillLibrary(root);

  assert.deepEqual(
    library.skills.map((skill) => [skill.name, skill.group, skill.origin.type]),
    [
      ['notes', 'First-party', 'local'],
      ['mermaid', 'Docs', 'catalog'],
    ],
  );
});

test('a first-party skill cannot share a name with a catalog entry', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, {
    'catalog.yaml': CATALOG,
    'skills/mermaid/SKILL.md': skillSource('mermaid'),
  });

  await assert.rejects(
    loadSkillLibrary(root),
    /mermaid is both a first-party skill and a catalog entry/,
  );
});

test('unknownSkillNames lists names that are in neither source', async (t) => {
  const root = await tempDir(t);
  await writeFiles(root, { 'catalog.yaml': CATALOG });
  const library = await loadSkillLibrary(root);

  const unknown = unknownSkillNames(library, ['mermaid', 'gone']);

  assert.deepEqual(unknown, ['gone']);
});
