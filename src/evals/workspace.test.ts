import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { Environment } from '../env.ts';
import { lstatIfExists } from '../install/fs.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { isolatedGitEnv } from '../test-support/git.ts';
import {
  findClaudePluginSkill,
  mapCaseFileRelativePath,
  personalSkillShadowWarning,
  prepareEvalWorkspace,
  prepareTriggerWorkspace,
  projectSkillsDir,
  stagedSkillDir,
  validateCaseFileDestinations,
  validateEvalSuiteFileDestinations,
} from './workspace.ts';

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
  const claudeSettings = JSON.parse(
    await readFile(
      join(claudeWorkspace.workdir, '.claude', 'settings.local.json'),
      'utf8',
    ),
  ) as {
    skillOverrides: Record<string, string>;
    permissions: { deny: string[] };
  };
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

  assert.equal(
    await lstatIfExists(join(agyWorkspace.workdir, '.agents', 'skills.json')),
    null,
  );
  assert.equal(agyWorkspace.possiblyContaminated, true);
  assert.match(agyWorkspace.warning ?? '', /possibly contaminated/);
  assert.equal(claudeSettings.skillOverrides['demo-skill'], 'off');
  assert.deepEqual(claudeSettings.permissions.deny, [
    'Skill(demo-skill)',
    'Skill(demo-skill *)',
    'Skill(skill:demo-skill)',
  ]);
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
    runner: 'agy',
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

interface CommitDemoSkillParams {
  repoRoot: string;
  env: Environment;
}

async function commitDemoSkill({
  repoRoot,
  env,
}: CommitDemoSkillParams): Promise<string> {
  await execFileAsync('git', ['init', '-q'], { cwd: repoRoot, env });
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
      '-q',
      '-m',
      'v1',
    ],
    { cwd: repoRoot, env },
  );
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    env,
  });
  return stdout.trim();
}

const plainCase = {
  id: 'plain-case',
  prompt: 'Do task',
  expected_output: 'Done',
  files: [],
  assertions: [],
};

test('projectSkillsDir follows the registry project skills folder per runner', () => {
  assert.equal(projectSkillsDir('claude'), '.claude/skills');
  assert.equal(projectSkillsDir('agy'), '.agents/skills');
  assert.equal(projectSkillsDir('codex'), '.agents/skills');
  assert.equal(projectSkillsDir('gemini'), '.agents/skills');
  assert.equal(projectSkillsDir('fake'), '.agents/skills');
});

test('claude workspaces stage the skill in .claude/skills for with_skill, old_skill and triggers', async (t) => {
  const repoRoot = await tempDir(t);
  const env = isolatedGitEnv(repoRoot);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });
  const ref = await commitDemoSkill({ repoRoot, env });

  const withSkill = await prepareEvalWorkspace({
    runDir: join(repoRoot, 'run-with'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'with_skill',
    runner: 'claude',
    env,
  });
  const oldSkill = await prepareEvalWorkspace({
    runDir: join(repoRoot, 'run-old'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'old_skill',
    runner: 'claude',
    repoRoot,
    compareRef: ref,
    env,
  });
  const triggerWorkdir = await prepareTriggerWorkspace({
    runDir: join(repoRoot, 'run-trigger'),
    skillDir,
    skillName: 'demo-skill',
    runner: 'claude',
    env,
  });

  for (const workdir of [withSkill.workdir, oldSkill.workdir, triggerWorkdir]) {
    assert.match(
      await readFile(
        join(workdir, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
        'utf8',
      ),
      /name: demo-skill/,
    );
    assert.equal(
      await lstatIfExists(join(workdir, '.agents', 'skills', 'demo-skill')),
      null,
    );
  }
  assert.equal(
    stagedSkillDir({
      workdir: withSkill.workdir,
      runner: 'claude',
      skillName: 'demo-skill',
    }),
    join(withSkill.workdir, '.claude', 'skills', 'demo-skill'),
  );
  assert.equal(withSkill.possiblyContaminated, false);
});

test('a personal Claude skill with the same name marks claude skill runs possibly contaminated', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });
  await writeFiles(join(paths.claudeHome, 'skills', 'demo-skill'), {
    'SKILL.md': skillSource('demo-skill'),
  });

  const claudeRun = await prepareEvalWorkspace({
    runDir: join(root, 'run-claude'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'with_skill',
    runner: 'claude',
    paths,
    env: isolatedGitEnv(root),
  });
  const agyRun = await prepareEvalWorkspace({
    runDir: join(root, 'run-agy'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'with_skill',
    runner: 'agy',
    paths,
    env: isolatedGitEnv(root),
  });

  assert.equal(claudeRun.skillShadowed, true);
  assert.equal(claudeRun.possiblyContaminated, false);
  assert.match(claudeRun.warning ?? '', /personal skill/);
  assert.match(
    (await personalSkillShadowWarning({
      runner: 'claude',
      skillName: 'demo-skill',
      paths,
    })) ?? '',
    /possibly contaminated/,
  );
  assert.equal(agyRun.possiblyContaminated, false);
  assert.equal(agyRun.skillShadowed, false);
  assert.equal(agyRun.warning, undefined);
});

test('agy baseline is clean without a skills.json when the skill is not installed anywhere', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });

  const prepared = await prepareEvalWorkspace({
    runDir: join(root, 'run-agy'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'without_skill',
    runner: 'agy',
    paths,
    env: isolatedGitEnv(root),
  });

  assert.equal(prepared.possiblyContaminated, false);
  assert.equal(
    await lstatIfExists(join(prepared.workdir, '.agents', 'skills.json')),
    null,
  );
});

test('agy baseline is possibly contaminated when an agy plugin provides the skill', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });
  await writeFiles(
    join(
      paths.geminiHome,
      'antigravity-cli',
      'plugins',
      'some-plugin',
      'skills',
      'demo-skill',
    ),
    { 'SKILL.md': skillSource('demo-skill') },
  );

  const prepared = await prepareEvalWorkspace({
    runDir: join(root, 'run-agy'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'without_skill',
    runner: 'agy',
    paths,
    env: isolatedGitEnv(root),
  });

  assert.equal(prepared.possiblyContaminated, true);
});

test('workspace git ignores global hooks and fsmonitor commands', async (t) => {
  const home = await tempDir(t);
  const env = isolatedGitEnv(home);
  const marker = join(home, 'hook-ran');
  const hooksDir = join(home, 'hooks');
  const script = `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`;
  await writeFiles(hooksDir, {
    'pre-commit': script,
    'commit-msg': script,
    'post-commit': script,
  });
  await writeFiles(home, { 'fsmonitor.sh': script });
  for (const name of ['pre-commit', 'commit-msg', 'post-commit']) {
    await chmod(join(hooksDir, name), 0o755);
  }
  await chmod(join(home, 'fsmonitor.sh'), 0o755);
  await writeFile(
    join(home, '.gitconfig'),
    `[core]\n\thooksPath = ${hooksDir}\n\tfsmonitor = ${join(home, 'fsmonitor.sh')}\n`,
  );
  const skillDir = join(home, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/files/hook-case/notes.txt': 'notes\n',
  });

  const prepared = await prepareEvalWorkspace({
    runDir: join(home, 'run'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: {
      ...plainCase,
      id: 'hook-case',
      files: ['evals/files/hook-case/notes.txt'],
    },
    variant: 'with_skill',
    runner: 'agy',
    env,
  });
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--format=%s', '-n', '1'],
    { cwd: prepared.workdir, env },
  );

  assert.equal(stdout.trim(), 'chore: eval workspace fixture');
  assert.equal(await lstatIfExists(marker), null);
});

test('workspace git ignores GIT_DIR and GIT_WORK_TREE pointing at another repository', async (t) => {
  const root = await tempDir(t);
  const baseEnv = isolatedGitEnv(root);
  const otherRepo = join(root, 'other');
  await writeFiles(otherRepo, { 'README.md': '# other\n' });
  await execFileAsync('git', ['init', '-q'], { cwd: otherRepo, env: baseEnv });
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });

  const prepared = await prepareEvalWorkspace({
    runDir: join(root, 'run'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'with_skill',
    runner: 'agy',
    env: {
      ...baseEnv,
      GIT_DIR: join(otherRepo, '.git'),
      GIT_WORK_TREE: otherRepo,
      GIT_INDEX_FILE: join(otherRepo, '.git', 'index'),
    },
  });

  const workspaceLog = await execFileAsync('git', ['log', '--format=%s'], {
    cwd: prepared.workdir,
    env: baseEnv,
  });
  const otherHead = await execFileAsync(
    'git',
    ['rev-parse', '--verify', '-q', 'HEAD'],
    { cwd: otherRepo, env: baseEnv },
  ).catch(() => null);
  const otherStatus = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: otherRepo,
    env: baseEnv,
  });

  assert.equal(workspaceLog.stdout.trim(), 'chore: eval workspace fixture');
  assert.equal(otherHead, null);
  assert.equal(otherStatus.stdout.trim(), '?? README.md');
});

test('validateCaseFileDestinations rejects fixtures mapped into .git, skill folders, harness dirs or onto each other', () => {
  const check = (files: string[]) => () =>
    validateCaseFileDestinations({
      evalCase: { id: 'case-one', files },
      skillName: 'demo-skill',
    });

  assert.doesNotThrow(
    check(['evals/files/case-one/src/app.ts', 'evals/files/shared/README.md']),
  );
  assert.throws(check(['evals/files/case-one/.git/hooks/pre-commit']), {
    name: 'EvalError',
    message: /maps into "\.git\/"/,
  });
  assert.throws(check(['evals/files/.GIT/config']), /maps into "\.git\/"/);
  assert.throws(
    check(['evals/files/case-one/.agents/skills/demo-skill/SKILL.md']),
    /staged skill folder "\.agents\/skills\/demo-skill\/"/,
  );
  assert.throws(
    check(['evals/files/case-one/.claude/skills/demo-skill/SKILL.md']),
    /staged skill folder "\.claude\/skills\/demo-skill\/"/,
  );
  for (const dir of ['.agents', '.claude', '.gemini', '.codex']) {
    assert.throws(
      check([`evals/files/case-one/${dir}/settings.json`]),
      new RegExp(`maps into "\\${dir}/"`),
    );
  }
  assert.throws(
    check(['evals/files/case-one/a.txt', 'evals/files/a.txt']),
    /map to the same destination "a\.txt"/,
  );
  assert.throws(
    check(['evals/files/case-one/README.md', 'evals/files/readme.md']),
    /map to the same destination/,
  );
  assert.throws(
    check(['evals/files/case-one/lib', 'evals/files/lib/index.ts']),
    /needs as a directory/,
  );
  assert.throws(
    () =>
      validateEvalSuiteFileDestinations({
        cases: [
          { id: 'ok', files: ['evals/files/ok/a.txt'] },
          { id: 'bad', files: ['evals/files/bad/.git/config'] },
        ],
        skillName: 'demo-skill',
      }),
    /Eval case "bad"/,
  );
});

test('prepareEvalWorkspace refuses a fixture mapped into .git before writing anything', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/files/bad-case/.git/hooks/post-checkout': '#!/bin/sh\n',
  });

  await assert.rejects(
    prepareEvalWorkspace({
      runDir: join(root, 'run'),
      skillDir,
      skillName: 'demo-skill',
      evalCase: {
        ...plainCase,
        id: 'bad-case',
        files: ['evals/files/bad-case/.git/hooks/post-checkout'],
      },
      variant: 'with_skill',
      runner: 'agy',
      env: isolatedGitEnv(root),
    }),
    { name: 'EvalError', message: /maps into "\.git\/"/ },
  );
  assert.equal(await lstatIfExists(join(root, 'run', 'workdir', '.git')), null);
});

test('fixture SKILL.fixture.md files are staged as SKILL.md', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/files/fixture-case/draft/SKILL.fixture.md': '# Fixture skill\n',
  });

  assert.equal(
    mapCaseFileRelativePath({
      fileEntry: 'evals/files/fixture-case/draft/SKILL.fixture.md',
      caseId: 'fixture-case',
    }),
    'draft/SKILL.md',
  );
  assert.throws(
    () =>
      validateCaseFileDestinations({
        evalCase: {
          id: 'fixture-case',
          files: ['evals/files/SKILL.fixture.md', 'evals/files/SKILL.md'],
        },
        skillName: 'demo-skill',
      }),
    /same destination "SKILL\.md"/,
  );

  const prepared = await prepareEvalWorkspace({
    runDir: join(root, 'run'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: {
      ...plainCase,
      id: 'fixture-case',
      files: ['evals/files/fixture-case/draft/SKILL.fixture.md'],
    },
    variant: 'without_skill',
    runner: 'fake',
    env: isolatedGitEnv(root),
  });

  assert.equal(
    await readFile(join(prepared.workdir, 'draft', 'SKILL.md'), 'utf8'),
    '# Fixture skill\n',
  );
  assert.equal(
    await lstatIfExists(join(prepared.workdir, 'draft', 'SKILL.fixture.md')),
    null,
  );
});

test('a Claude plugin skill with the same name marks the claude baseline possibly contaminated', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skillDir = join(root, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });

  const clean = await prepareEvalWorkspace({
    runDir: join(root, 'run-clean'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'without_skill',
    runner: 'claude',
    paths,
    env: isolatedGitEnv(root),
  });
  await writeFiles(
    join(
      paths.claudeHome,
      'plugins',
      'cache',
      'some-marketplace',
      'some-plugin',
      '1.0.0',
      'skills',
      'demo-skill',
    ),
    { 'SKILL.md': skillSource('demo-skill') },
  );
  const contaminated = await prepareEvalWorkspace({
    runDir: join(root, 'run-plugin'),
    skillDir,
    skillName: 'demo-skill',
    evalCase: plainCase,
    variant: 'without_skill',
    runner: 'claude',
    paths,
    env: isolatedGitEnv(root),
  });

  assert.equal(clean.possiblyContaminated, false);
  assert.equal(clean.warning, undefined);
  assert.equal(contaminated.possiblyContaminated, true);
  assert.equal(contaminated.skillShadowed, false);
  assert.match(contaminated.warning ?? '', /plugin skill/);
  assert.equal(
    await findClaudePluginSkill({ skillName: 'other-skill', paths }),
    undefined,
  );

  // Symlinked plugin directory with a loop back to plugins root.
  const externalPlugin = join(root, 'external-plugin');
  await writeFiles(join(externalPlugin, 'skills', 'linked-skill'), {
    'SKILL.md': skillSource('linked-skill'),
  });
  await symlink(externalPlugin, join(paths.claudeHome, 'plugins', 'linked'));
  await symlink(
    join(paths.claudeHome, 'plugins'),
    join(externalPlugin, 'loop'),
  );
  assert.equal(
    await findClaudePluginSkill({ skillName: 'linked-skill', paths }),
    join(paths.claudeHome, 'plugins', 'linked', 'skills', 'linked-skill'),
  );
});

test('prepareEvalWorkspace excludes competing skills across variants and propagates contamination and shadowing for compare workspaces', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const env = isolatedGitEnv(root);
  const skillDir = join(root, 'skills', 'demo-skill');
  const skillBDir = join(root, 'skills', 'skill-b');
  const skillCDir = join(root, 'skills', 'skill-c');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });
  await writeFiles(skillBDir, { 'SKILL.md': skillSource('skill-b') });
  await writeFiles(skillCDir, { 'SKILL.md': skillSource('skill-c') });
  await writeFiles(join(paths.claudeHome, 'skills', 'skill-b'), {
    'SKILL.md': skillSource('skill-b'),
  });
  await writeFiles(join(paths.skillsDir, 'demo-skill'), {
    'SKILL.md': skillSource('demo-skill'),
  });
  const compareSkills = [
    { skillName: 'skill-b', skillDir: skillBDir },
    { skillName: 'skill-c', skillDir: skillCDir },
  ];

  const [withoutClaude, withClaude, compareBClaude, compareBAgy] =
    await Promise.all([
      prepareEvalWorkspace({
        runDir: join(root, 'run-without-claude'),
        skillDir,
        skillName: 'demo-skill',
        evalCase: plainCase,
        variant: 'without_skill',
        runner: 'claude',
        compareSkills,
        paths,
        env,
      }),
      prepareEvalWorkspace({
        runDir: join(root, 'run-with-claude'),
        skillDir,
        skillName: 'demo-skill',
        evalCase: plainCase,
        variant: 'with_skill',
        runner: 'claude',
        compareSkills,
        paths,
        env,
      }),
      prepareEvalWorkspace({
        runDir: join(root, 'run-compare-b-claude'),
        skillDir,
        skillName: 'demo-skill',
        evalCase: plainCase,
        variant: 'compare:skill-b',
        runner: 'claude',
        compareSkill: { skillName: 'skill-b', skillDir: skillBDir },
        compareSkills,
        paths,
        env,
      }),
      prepareEvalWorkspace({
        runDir: join(root, 'run-compare-b-agy'),
        skillDir,
        skillName: 'demo-skill',
        evalCase: plainCase,
        variant: 'compare:skill-b',
        runner: 'agy',
        compareSkill: { skillName: 'skill-b', skillDir: skillBDir },
        compareSkills,
        paths,
        env,
      }),
    ]);
  const withoutSettings = JSON.parse(
    await readFile(
      join(withoutClaude.workdir, '.claude', 'settings.local.json'),
      'utf8',
    ),
  ) as { skillOverrides: Record<string, string> };
  const withSettings = JSON.parse(
    await readFile(
      join(withClaude.workdir, '.claude', 'settings.local.json'),
      'utf8',
    ),
  ) as { skillOverrides: Record<string, string> };
  const compareBSettings = JSON.parse(
    await readFile(
      join(compareBClaude.workdir, '.claude', 'settings.local.json'),
      'utf8',
    ),
  ) as { skillOverrides: Record<string, string> };

  assert.deepEqual(withoutSettings.skillOverrides, {
    'demo-skill': 'off',
    'skill-b': 'off',
    'skill-c': 'off',
  });
  assert.deepEqual(withSettings.skillOverrides, {
    'skill-b': 'off',
    'skill-c': 'off',
  });
  assert.deepEqual(compareBSettings.skillOverrides, {
    'demo-skill': 'off',
    'skill-c': 'off',
  });
  assert.equal(compareBClaude.skillShadowed, true);
  assert.match(compareBClaude.warning ?? '', /staged project skill "skill-b"/);
  assert.equal(compareBAgy.possiblyContaminated, true);
  assert.match(
    compareBAgy.warning ?? '',
    /"demo-skill" is installed globally.*compare:skill-b is possibly contaminated/,
  );
});
