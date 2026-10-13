import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { skillSource, tempDir, writeFiles } from '../test-support/fixtures.ts';
import { isSkillName, validateSkill } from './validate.ts';

interface SkillDirParams {
  root: string;
  folder: string;
  files: Record<string, string>;
}

async function skillDir({
  root,
  folder,
  files,
}: SkillDirParams): Promise<string> {
  await writeFiles(join(root, folder), files);
  return join(root, folder);
}

test('a spec-compliant first-party skill passes strict validation cleanly', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'pdf-tools',
    files: {
      'SKILL.md': skillSource('pdf-tools', {
        license: 'MIT',
        compatibility: 'Requires git',
        metadata: { version: '1.0' },
        'allowed-tools': 'Read',
      }),
    },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report, {
    dir,
    name: 'pdf-tools',
    errors: [],
    warnings: [],
  });
});

test('isSkillName applies the spec naming rules', () => {
  const names = ['pdf', 'a1-b2', 'PDF', '-pdf', 'pdf-', 'pdf--x', 'a_b', ''];

  const valid = names.filter(isSkillName);

  assert.deepEqual(valid, ['pdf', 'a1-b2']);
});

test('isSkillName rejects names longer than 64 characters', () => {
  assert.equal(isSkillName('a'.repeat(65)), false);
});

test('strict validation requires the name to match the folder', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'skill_creator',
    files: { 'SKILL.md': skillSource('skill-creator') },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.errors, [
    'name "skill-creator" must match the folder "skill_creator"',
  ]);
});

test('strict validation rejects fields outside the spec', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'deploy',
    files: { 'SKILL.md': skillSource('deploy', { hooks: { start: 'x' } }) },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.errors, ['unknown field "hooks"']);
});

test('lenient validation allows fields outside the spec', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'deploy',
    files: { 'SKILL.md': skillSource('deploy', { hooks: { start: 'x' } }) },
  });

  const report = await validateSkill(dir, { strict: false });

  assert.deepEqual(report.errors, []);
});

test('strict validation requires string metadata values and limits field lengths', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'deploy',
    files: {
      'SKILL.md': skillSource('deploy', {
        description: `Use when deploying. ${'x'.repeat(1024)}`,
        compatibility: 'y'.repeat(501),
        metadata: { version: 2 },
      }),
    },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.errors, [
    'description must be at most 1024 characters',
    'compatibility must be at most 500 characters',
    'metadata.version must be a string',
  ]);
});

test('lenient validation reports spec limits as warnings', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'deploy',
    files: {
      'SKILL.md': skillSource('deploy', {
        description: `Use when deploying. ${'x'.repeat(1024)}`,
      }),
    },
  });

  const report = await validateSkill(dir, { strict: false });

  assert.deepEqual(report, {
    dir,
    name: 'deploy',
    errors: [],
    warnings: ['description must be at most 1024 characters'],
  });
});

test('lenient validation still requires a valid name and a description', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'deploy',
    files: { 'SKILL.md': '---\nname: Deploy\n---\n\nBody\n' },
  });

  const report = await validateSkill(dir, { strict: false });

  assert.deepEqual(report.errors, [
    'name may only contain lowercase letters, digits and hyphens',
    'description is required',
  ]);
});

test('a missing SKILL.md is an error', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'empty',
    files: { 'README.md': '# Empty\n' },
  });

  const report = await validateSkill(dir, { strict: false });

  assert.deepEqual(report.errors, ['SKILL.md is missing']);
});

test('frontmatter that is not valid YAML is an error', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'broken',
    files: { 'SKILL.md': '---\nname: [broken\n---\n\nBody\n' },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.errors, ['SKILL.md: invalid YAML frontmatter']);
});

test('a catalog skill must declare the name the catalog expects', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'use-ai-sdk',
    files: { 'SKILL.md': skillSource('ai-sdk-helper') },
  });

  const report = await validateSkill(dir, {
    strict: false,
    expectedName: 'ai-sdk',
  });

  assert.deepEqual(report.errors, [
    'declares name "ai-sdk-helper" instead of "ai-sdk"',
  ]);
});

test('warns when the body reaches 500 lines and the description never says when', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'long',
    files: {
      'SKILL.md': `${skillSource('long', { description: 'Formats long documents.' })}${'line\n'.repeat(500)}`,
    },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.warnings, [
    'SKILL.md body has 501 lines; keep it under 500 and move detail into references',
    'description should say when to use the skill, for example "Use when ..."',
  ]);
});

test('warns when a referenced file links to further references', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'guide',
    files: {
      'SKILL.md': `${skillSource('guide')}\nSee [the API](references/api.md) and [the site](https://example.com/x.md).\n`,
      'references/api.md': 'Details in [errors](errors.md).\n',
      'references/errors.md': 'Errors.\n',
    },
  });

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.warnings, [
    'references/api.md links to references/errors.md; keep references one level deep from SKILL.md',
  ]);
});

test('links that are absolute or leave the skill folder are errors', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'linked',
    files: { 'SKILL.md': skillSource('linked'), 'docs/guide.md': 'g\n' },
  });
  await symlink('/etc/hosts', join(dir, 'hosts'));
  await symlink('../../shared', join(dir, 'docs', 'shared'));

  const report = await validateSkill(dir, { strict: false });

  assert.deepEqual(report.errors, [
    'docs/shared links outside the skill folder (../../shared); links must be relative and stay inside it',
    'hosts links outside the skill folder (/etc/hosts); links must be relative and stay inside it',
  ]);
});

test('links that stay inside the skill folder are allowed', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'linked',
    files: { 'SKILL.md': skillSource('linked'), 'docs/guide.md': 'g\n' },
  });
  await symlink('docs/guide.md', join(dir, 'guide.md'));
  await symlink('../guide.md', join(dir, 'docs', 'again.md'));

  const report = await validateSkill(dir, { strict: true });

  assert.deepEqual(report.errors, []);
});

test('a link chain that leaves the skill folder is an error', async (t) => {
  const root = await tempDir(t);
  const dir = await skillDir({
    root,
    folder: 'linked',
    files: { 'SKILL.md': skillSource('linked'), 'deep/file.md': 'f\n' },
  });
  await symlink('..', join(dir, 'deep', 'up'));
  await symlink('deep/up/../../secret.txt', join(dir, 'leak'));

  const report = await validateSkill(dir, { strict: false });

  assert.deepEqual(report.errors, [
    'leak links outside the skill folder (deep/up/../../secret.txt); links must be relative and stay inside it',
  ]);
});
