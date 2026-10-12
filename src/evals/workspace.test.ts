import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { lstatIfExists } from '../install/fs.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { isolatedGitEnv } from '../test-support/git.ts';
import { prepareEvalWorkspace, prepareTriggerWorkspace } from './workspace.ts';

const execFileAsync = promisify(execFile);

test('prepareEvalWorkspace sets up with_skill workdir with clean git status and stripped case prefix', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'references/guide.md': '# Guide\n',
    'evals/files/case-one/package.json': '{"name":"fixture"}\n',
    'evals/evals.json': '{}',
  });

  const prepared = await prepareEvalWorkspace({
    runDir: join(root, 'run-1'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: {
      id: 'case-one',
      prompt: 'Fix package.json',
      expected_output: 'Updated package.json',
      files: ['evals/files/case-one/package.json'],
      assertions: [],
    },
    variant: 'with_skill',
    runner: 'agy',
    env: isolatedGitEnv(root),
  });
  const pkg = await readFile(join(prepared.workdir, 'package.json'), 'utf8');
  const installedSkill = await readFile(
    join(prepared.workdir, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    'utf8',
  );
  const evalsInInstalled = await lstatIfExists(
    join(prepared.workdir, '.agents', 'skills', 'demo-skill', 'evals'),
  );
  const { stdout: statusOut } = await execFileAsync(
    'git',
    ['status', '--porcelain'],
    { cwd: prepared.workdir, env: isolatedGitEnv(root) },
  );

  assert.equal(pkg, '{"name":"fixture"}\n');
  assert.match(installedSkill, /name: demo-skill/);
  assert.equal(evalsInInstalled, null);
  assert.equal(statusOut.trim(), '');
  assert.equal(prepared.possiblyContaminated, false);
});

test('prepareEvalWorkspace excludes skill at workspace level for without_skill and never touches global skills', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
  });
  await writeFiles(join(paths.skillsDir, 'demo-skill'), {
    'SKILL.md': skillSource('demo-skill'),
  });
  const evalCase = {
    id: 'baseline-case',
    prompt: 'Do task',
    expected_output: 'Done',
    files: [],
    assertions: [],
  };

  const agyWorkspace = await prepareEvalWorkspace({
    runDir: join(root, 'run-agy'),
    skillDir,
    skillName: 'demo-skill',
    evalCase,
    variant: 'without_skill',
    runner: 'agy',
    paths,
    env: isolatedGitEnv(root),
  });
  const claudeWorkspace = await prepareEvalWorkspace({
    runDir: join(root, 'run-claude'),
    skillDir,
    skillName: 'demo-skill',
    evalCase,
    variant: 'without_skill',
    runner: 'claude',
    paths,
    env: isolatedGitEnv(root),
  });
  const geminiWorkspace = await prepareEvalWorkspace({
    runDir: join(root, 'run-gemini'),
    skillDir,
    skillName: 'demo-skill',
    evalCase,
    variant: 'without_skill',
    runner: 'gemini',
    paths,
    env: isolatedGitEnv(root),
  });
  const codexWorkspace = await prepareEvalWorkspace({
    runDir: join(root, 'run-codex'),
    skillDir,
    skillName: 'demo-skill',
    evalCase,
    variant: 'without_skill',
    runner: 'codex',
    paths,
    env: isolatedGitEnv(root),
  });
  const agyExclude = JSON.parse(
    await readFile(
      join(agyWorkspace.workdir, '.agents', 'skills.json'),
      'utf8',
    ),
  ) as { exclude: string[] };
  const claudeSettings = JSON.parse(
    await readFile(
      join(claudeWorkspace.workdir, '.claude', 'settings.local.json'),
      'utf8',
    ),
  ) as { skillOverrides: Record<string, string> };
  const geminiSettings = JSON.parse(
    await readFile(
      join(geminiWorkspace.workdir, '.gemini', 'settings.json'),
      'utf8',
    ),
  ) as { skills: { disabled: string[] } };
  const globalSkillAfter = await readFile(
    join(paths.skillsDir, 'demo-skill', 'SKILL.md'),
    'utf8',
  );

  assert.deepEqual(agyExclude, { exclude: ['demo-skill'] });
  assert.equal(agyWorkspace.possiblyContaminated, false);
  assert.equal(claudeSettings.skillOverrides['demo-skill'], 'off');
  assert.equal(claudeWorkspace.possiblyContaminated, false);
  assert.deepEqual(geminiSettings.skills.disabled, ['demo-skill']);
  assert.equal(geminiWorkspace.possiblyContaminated, false);
  assert.equal(codexWorkspace.possiblyContaminated, true);
  assert.match(codexWorkspace.warning ?? '', /possibly contaminated/);
  assert.match(globalSkillAfter, /name: demo-skill/);
});

test('prepareEvalWorkspace detects globally installed plugin skills via scanInstalledSkills', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
  });
  await writeFiles(
    join(
      paths.geminiHome,
      'config',
      'plugins',
      'custom-plugin',
      'skills',
      'custom-dir',
    ),
    {
      'SKILL.md': skillSource('demo-skill'),
    },
  );

  const codexWorkspace = await prepareEvalWorkspace({
    runDir: join(root, 'run-codex-plugin'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: {
      id: 'plugin-case',
      prompt: 'Do task',
      expected_output: 'Done',
      files: [],
      assertions: [],
    },
    variant: 'without_skill',
    runner: 'codex',
    paths,
    env: isolatedGitEnv(root),
  });

  assert.equal(codexWorkspace.possiblyContaminated, true);
  assert.match(codexWorkspace.warning ?? '', /possibly contaminated/);
});

test('prepareEvalWorkspace extracts old_skill snapshot from git ref and prepareTriggerWorkspace installs skill', async (t) => {
  const repoRoot = await tempDir(t);
  const env = isolatedGitEnv(repoRoot);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': `${skillSource('demo-skill')}\nOld instructions v1.\n`,
  });
  await execFileAsync('git', ['init'], { cwd: repoRoot, env });
  await execFileAsync('git', ['add', '-A'], { cwd: repoRoot, env });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'v1',
    ],
    { cwd: repoRoot, env },
  );
  const { stdout: v1Sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    env,
  });
  await writeFiles(skillDir, {
    'SKILL.md': `${skillSource('demo-skill')}\nNew instructions v2.\n`,
  });

  const oldWorkspace = await prepareEvalWorkspace({
    runDir: join(repoRoot, 'run-old'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: {
      id: 'compare-case',
      prompt: 'Run',
      expected_output: 'Done',
      files: [],
      assertions: [],
    },
    variant: 'old_skill',
    runner: 'agy',
    repoRoot,
    compareRef: v1Sha.trim(),
    env,
  });
  const triggerWorkdir = await prepareTriggerWorkspace({
    runDir: join(repoRoot, 'run-trigger'),
    skillDir,
    skillName: 'demo-skill',
    env,
  });
  const oldSkillContent = await readFile(
    join(oldWorkspace.workdir, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    'utf8',
  );
  const triggerSkillContent = await readFile(
    join(triggerWorkdir, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    'utf8',
  );

  assert.match(oldSkillContent, /Old instructions v1/);
  assert.match(triggerSkillContent, /New instructions v2/);
});
