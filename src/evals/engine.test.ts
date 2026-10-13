import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { Environment } from '../env.ts';
import { EvalError, RunnerError } from '../errors.ts';
import { lstatIfExists } from '../install/fs.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { isolatedGitEnv } from '../test-support/git.ts';
import {
  allocateIterationDir,
  findLatestIterationDir,
  regenerateSkillReport,
  runSkillEval,
  runSkillTriggers,
} from './engine.ts';
import { createFakeRunner } from './runners/index.ts';
import type { EvalRunner } from './runners/types.ts';
import { extractSkillAtRef } from './workspace.ts';

const execFileAsync = promisify(execFile);

test('runSkillEval runs with_skill and without_skill, grades assertions, writes benchmark.json and report.md, and cleans workdirs', async (t) => {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/files/case-1/input.txt': 'hello\n',
    'evals/evals.json': JSON.stringify({
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'case-1',
          prompt: 'Process input.txt',
          expected_output: 'Processed input.txt with skill',
          files: ['evals/files/case-1/input.txt'],
          assertions: [
            'The output confirms skill execution',
            { type: 'file_exists', path: 'input.txt' },
          ],
        },
      ],
    }),
  });
  const runner = createFakeRunner();

  const evalResult = await runSkillEval({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    runs: 2,
    baseline: true,
    parallel: 2,
    paths,
    env: isolatedGitEnv(repoRoot),
  });
  const regenerated = await regenerateSkillReport({
    evalsRootDir: paths.evalsDir,
    skillName: 'demo-skill',
  });
  const workdirAfter = await lstatIfExists(
    join(
      evalResult.iterationDir,
      'eval-case-1',
      'with_skill',
      'run-1',
      'workdir',
    ),
  );
  const reportOnDisk = await readFile(
    join(evalResult.iterationDir, 'report.md'),
    'utf8',
  );

  assert.equal(evalResult.benchmark.metadata.skill_name, 'demo-skill');
  assert.equal(evalResult.benchmark.run_summary.with_skill.pass_rate.mean, 1);
  assert.equal(
    evalResult.benchmark.run_summary.without_skill?.pass_rate.mean,
    0.5,
  );
  assert.equal(workdirAfter, null);
  assert.equal(regenerated.iterationDir, evalResult.iterationDir);
  assert.match(reportOnDisk, /Skill Evaluation Report: `demo-skill`/);
});

test('runSkillTriggers evaluates trigger queries on requested split and writes triggers.json and triggers.md', async (t) => {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/trigger_queries.json': JSON.stringify([
      { query: 'Please run demo-skill on my project', should_trigger: true },
      { query: 'Help me configure demo-skill options', should_trigger: true },
      { query: '[negative] Unrelated database query', should_trigger: false },
      { query: '[negative] Another unrelated task', should_trigger: false },
    ]),
  });
  const runner = createFakeRunner();

  const result = await runSkillTriggers({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    split: 'all',
    runs: 1,
    threshold: 0.5,
    parallel: 2,
    env: isolatedGitEnv(repoRoot),
  });
  const triggersJson = await readFile(
    join(result.outputDir, 'triggers.json'),
    'utf8',
  );

  assert.equal(result.summary.metrics.total_queries, 4);
  assert.equal(result.summary.metrics.accuracy, 1);
  assert.match(triggersJson, /"accuracy": 1/);
  assert.match(
    result.reportMarkdown,
    /Trigger Evaluation Report: `demo-skill`/,
  );
});

const evalSuite = (
  assertions: unknown[] = ['The output confirms skill execution'],
) =>
  JSON.stringify({
    skill_name: 'demo-skill',
    evals: [
      {
        id: 'case-1',
        prompt: 'Process input',
        expected_output: 'Processed input with skill',
        assertions,
      },
      {
        id: 'case-2',
        prompt: 'Process more input',
        expected_output: 'Processed more input with skill',
        assertions,
      },
    ],
  });

interface DemoSkillParams {
  t: TestContext;
  files?: Record<string, string>;
}

async function demoSkill({ t, files = {} }: DemoSkillParams) {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/evals.json': evalSuite(),
    ...files,
  });
  return { paths, repoRoot, skillDir, env: isolatedGitEnv(repoRoot) };
}

interface GitParams {
  cwd: string;
  env: Environment;
  args: string[];
}

async function git({ cwd, env, args }: GitParams): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout.trim();
}

async function commitAll(cwd: string, env: Environment): Promise<string> {
  await git({ cwd, env, args: ['add', '-A'] });
  await git({
    cwd,
    env,
    args: [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'snapshot',
    ],
  });
  return git({ cwd, env, args: ['rev-parse', 'HEAD'] });
}

test('runSkillEval records a failed run when one job fails and still writes the report', async (t) => {
  const { paths, skillDir, env } = await demoSkill({ t });
  const fake = createFakeRunner();
  const prompts: string[] = [];
  const runner: EvalRunner = {
    ...fake,
    async runTask(request) {
      prompts.push(request.prompt);
      if (request.prompt === 'Process input' && request.excludeSkill) {
        throw new RunnerError('claude could not be started');
      }
      const result = await fake.runTask(request);
      if (request.prompt === 'Process more input' && request.excludeSkill) {
        return { ...result, timedOut: true, error: 'Timed out after 5s' };
      }
      return result;
    },
  };
  const logs: string[] = [];

  const result = await runSkillEval({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    parallel: 2,
    paths,
    env,
    onLog: (line) => logs.push(line),
  });
  const runs = result.benchmark.cases.flatMap((item) => item.runs);
  const failed = runs.filter((run) => run.timing.error !== undefined);
  const benchmarkOnDisk = await lstatIfExists(
    join(result.iterationDir, 'benchmark.json'),
  );
  const timingOnDisk = JSON.parse(
    await readFile(
      join(
        result.iterationDir,
        'eval-case-1',
        'without_skill',
        'run-1',
        'timing.json',
      ),
      'utf8',
    ),
  ) as { error?: string; usage_reported?: boolean };

  assert.equal(prompts.length, 4);
  assert.equal(runs.length, 4);
  assert.deepEqual(
    failed.map((run) => [run.case_id, run.variant, run.timing.error]).sort(),
    [
      ['case-1', 'without_skill', 'claude could not be started'],
      ['case-2', 'without_skill', 'Timed out after 5s'],
    ],
  );
  for (const run of failed) {
    assert.equal(run.grading.summary.passed, 0);
    assert.match(
      run.grading.expectations[0]?.evidence ?? '',
      /^Agent run failed: /,
    );
  }
  assert.equal(result.benchmark.run_summary.with_skill.pass_rate.mean, 1);
  assert.equal(timingOnDisk.error, 'claude could not be started');
  assert.equal(timingOnDisk.usage_reported, false);
  assert.ok(benchmarkOnDisk?.isFile());
  assert.ok(
    logs.some((line) =>
      /\[case-1\] without_skill run 1\/1: agent run failed: claude could not be started/.test(
        line,
      ),
    ),
  );
});

test('runSkillEval stops scheduling after a fatal error and leaves no completed iteration', async (t) => {
  const { paths, skillDir, env } = await demoSkill({ t });
  const fake = createFakeRunner();
  let taskCalls = 0;
  const runner: EvalRunner = {
    ...fake,
    async runTask(request) {
      taskCalls += 1;
      if (taskCalls === 1) {
        // Occupy grading.json with a folder so writing the results fails.
        await mkdir(join(request.runDir, 'grading.json'), { recursive: true });
      }
      return fake.runTask(request);
    },
  };

  await assert.rejects(
    runSkillEval({
      skillName: 'demo-skill',
      skillDir,
      evalsRootDir: paths.evalsDir,
      runner,
      parallel: 2,
      paths,
      env,
    }),
    /EISDIR/,
  );
  // Give a worker that kept scheduling time to start more jobs.
  await new Promise((resolve) => setTimeout(resolve, 300));

  // The second worker finishes the job it had started, then stops.
  assert.equal(taskCalls, 2);
  await assert.rejects(
    findLatestIterationDir({
      evalsRootDir: paths.evalsDir,
      skillName: 'demo-skill',
    }),
    /No completed evaluation iterations found for "demo-skill"/,
  );
});

test('runSkillEval runs preflight checks before allocating an iteration', async (t) => {
  const { paths, repoRoot, skillDir, env } = await demoSkill({ t });
  const fake = createFakeRunner();
  let taskCalls = 0;
  const missingBinary: EvalRunner = {
    ...fake,
    preflight() {
      return Promise.reject(new RunnerError('claude binary not found on PATH'));
    },
    async runTask(request) {
      taskCalls += 1;
      return fake.runTask(request);
    },
  };
  await git({ cwd: repoRoot, env, args: ['init', '-q'] });
  await commitAll(repoRoot, env);
  const attempt = (runner: EvalRunner, compareRef?: string) =>
    runSkillEval({
      skillName: 'demo-skill',
      skillDir,
      evalsRootDir: paths.evalsDir,
      runner,
      compareRef,
      paths,
      env,
    });

  await assert.rejects(attempt(missingBinary), /claude binary not found/);
  await assert.rejects(attempt(fake, 'no-such-ref'), /does not name a commit/);
  await assert.rejects(attempt(fake, '--output=/tmp/x'), /Invalid git ref/);
  const emptyTree = await git({
    cwd: repoRoot,
    env,
    args: ['hash-object', '-t', 'tree', '-w', '/dev/null'],
  });
  const emptyCommit = await git({
    cwd: repoRoot,
    env,
    args: [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit-tree',
      emptyTree,
      '-m',
      'empty',
    ],
  });
  await assert.rejects(
    attempt(fake, emptyCommit),
    /Skill "skills\/demo-skill" does not exist at ref/,
  );

  assert.equal(taskCalls, 0);
  assert.equal(await lstatIfExists(join(paths.evalsDir, 'demo-skill')), null);
});

test('runSkillEval --compare derives the repository from the skill folder and runs old_skill', async (t) => {
  const { paths, repoRoot, env } = await demoSkill({ t });
  const nestedRepo = join(repoRoot, 'nested');
  const skillDir = join(nestedRepo, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': `${skillSource('demo-skill')}\nOld instructions.\n`,
    'evals/evals.json': evalSuite(),
  });
  await git({ cwd: nestedRepo, env, args: ['init', '-q'] });
  const oldSha = await commitAll(nestedRepo, env);
  await writeFiles(skillDir, {
    'SKILL.md': `${skillSource('demo-skill')}\nNew instructions.\n`,
  });

  const result = await runSkillEval({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner: createFakeRunner(),
    baseline: false,
    compareRef: oldSha,
    paths,
    env,
  });
  const variants = result.benchmark.cases
    .flatMap((item) => item.runs)
    .map((run) => run.variant)
    .sort();

  assert.deepEqual(variants, [
    'old_skill',
    'old_skill',
    'with_skill',
    'with_skill',
  ]);
  assert.equal(result.benchmark.metadata.compare_ref, oldSha);
});

test('allocateIterationDir gives concurrent callers distinct directories', async (t) => {
  const evalsRootDir = await tempDir(t);

  const dirs = await Promise.all(
    Array.from({ length: 8 }, () =>
      allocateIterationDir({ evalsRootDir, skillName: 'demo-skill' }),
    ),
  );

  assert.equal(new Set(dirs).size, 8);
  assert.deepEqual(
    (await readdir(join(evalsRootDir, 'demo-skill'))).sort(),
    Array.from({ length: 8 }, (_, idx) => `iteration-${idx + 1}`).sort(),
  );
});

test('findLatestIterationDir skips iterations without benchmark.json', async (t) => {
  const evalsRootDir = await tempDir(t);
  await writeFiles(join(evalsRootDir, 'demo-skill'), {
    'iteration-1/benchmark.json': '{}',
    'iteration-2/benchmark.json': '{}',
    'iteration-3/eval-case-1/with_skill/run-1/timing.json': '{}',
  });
  await mkdir(join(evalsRootDir, 'demo-skill', 'iteration-10'));

  const latest = await findLatestIterationDir({
    evalsRootDir,
    skillName: 'demo-skill',
  });

  assert.equal(latest, join(evalsRootDir, 'demo-skill', 'iteration-2'));
});

test('extractSkillAtRef restores special file names, executables and in-skill links from a ref', async (t) => {
  const root = await tempDir(t);
  const env = isolatedGitEnv(root);
  const repoRoot = join(root, 'repo');
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  const names = [
    'caf\u00e9 notes.md',
    'tab\there.md',
    '"quoted".md',
    'line\nbreak.md',
    '-dash.md',
  ];
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'references/guide.md': 'guide\n',
    'scripts/run.sh': '#!/bin/sh\necho ok\n',
    ...Object.fromEntries(names.map((name) => [name, `${name}\n`])),
  });
  await chmod(join(skillDir, 'scripts', 'run.sh'), 0o755);
  await symlink('references/guide.md', join(skillDir, 'guide-link.md'));
  await writeFiles(join(repoRoot, 'skills', 'other'), { 'SKILL.md': 'x\n' });
  await git({ cwd: repoRoot, env, args: ['init', '-q'] });
  const sha = await commitAll(repoRoot, env);
  const destDir = join(root, 'snapshot');

  await extractSkillAtRef({ repoRoot, skillDir, ref: sha, destDir, env });

  for (const name of names) {
    assert.equal(await readFile(join(destDir, name), 'utf8'), `${name}\n`);
  }
  assert.ok((await lstat(join(destDir, 'guide-link.md'))).isSymbolicLink());
  assert.equal(
    await readlink(join(destDir, 'guide-link.md')),
    'references/guide.md',
  );
  assert.equal(
    (await stat(join(destDir, 'scripts', 'run.sh'))).mode & 0o111,
    0o111,
  );
  assert.equal(await lstatIfExists(join(destDir, 'other')), null);
});

test('extractSkillAtRef rejects links that leave the skill and refs that look like options', async (t) => {
  const root = await tempDir(t);
  const env = isolatedGitEnv(root);
  const repoRoot = join(root, 'repo');
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, { 'SKILL.md': skillSource('demo-skill') });
  await writeFile(join(repoRoot, 'secret.txt'), 'secret\n');
  await symlink('../../secret.txt', join(skillDir, 'leak.md'));
  await git({ cwd: repoRoot, env, args: ['init', '-q'] });
  const sha = await commitAll(repoRoot, env);

  await assert.rejects(
    extractSkillAtRef({
      repoRoot,
      skillDir,
      ref: sha,
      destDir: join(root, 'snapshot'),
      env,
    }),
    (error: unknown) =>
      error instanceof EvalError &&
      /links that point outside the skill: leak\.md -> \.\.\/\.\.\/secret\.txt/.test(
        error.message,
      ),
  );
  await assert.rejects(
    extractSkillAtRef({
      repoRoot,
      skillDir,
      ref: '--output=/tmp/pwned',
      destDir: join(root, 'snapshot-2'),
      env,
    }),
    /Invalid git ref/,
  );
});
