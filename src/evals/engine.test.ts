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
      { query: 'Unrelated database query', should_trigger: false },
      { query: 'Another unrelated task', should_trigger: false },
    ]),
  });
  const runner = createFakeRunner({
    onTask: ({ prompt }) => ({ triggered: prompt.includes('demo-skill') }),
  });

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

const triggerQueries = JSON.stringify([
  { query: 'Please run demo-skill on my project', should_trigger: true },
  { query: 'Help me configure demo-skill options', should_trigger: true },
  { query: 'Unrelated database query', should_trigger: false },
]);

test('runSkillTriggers warns once and marks the summary possibly contaminated when a personal Claude skill shadows the staged one', async (t) => {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/trigger_queries.json': triggerQueries,
  });
  await writeFiles(join(paths.claudeHome, 'skills', 'demo-skill'), {
    'SKILL.md': skillSource('demo-skill'),
  });
  const runner: EvalRunner = {
    ...createFakeRunner({
      onTask: ({ prompt }) => ({ triggered: prompt.includes('demo-skill') }),
    }),
    name: 'claude',
  };
  const logs: string[] = [];

  const result = await runSkillTriggers({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    parallel: 2,
    paths,
    env: isolatedGitEnv(repoRoot),
    onLog: (line) => logs.push(line),
  });
  const onDisk = JSON.parse(
    await readFile(join(result.outputDir, 'triggers.json'), 'utf8'),
  ) as { metadata: { possibly_contaminated: boolean; warnings: string[] } };

  assert.equal(result.summary.metadata.possibly_contaminated, true);
  assert.equal(result.summary.metadata.warnings.length, 1);
  assert.match(result.summary.metadata.warnings[0] ?? '', /personal skill/);
  assert.equal(
    logs.filter((line) => line.includes('personal skill')).length,
    1,
  );
  assert.equal(onDisk.metadata.possibly_contaminated, true);
  assert.match(result.reportMarkdown, /possibly contaminated/);
  assert.match(result.reportMarkdown, /## Warnings/);
});

test('runSkillTriggers records failed and throwing runner results as errored runs', async (t) => {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/trigger_queries.json': triggerQueries,
  });
  const runner = createFakeRunner({
    onTask: ({ prompt }) => {
      if (prompt.startsWith('Please')) {
        return { triggered: true, error: 'claude exited with code 1' };
      }
      if (prompt.startsWith('Help')) {
        throw new RunnerError('spawn failed');
      }
      return { triggered: false };
    },
  });

  const result = await runSkillTriggers({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    parallel: 1,
    paths,
    env: isolatedGitEnv(repoRoot),
  });
  const byQuery = new Map(
    result.summary.queries.map((item) => [item.query, item]),
  );

  assert.equal(result.summary.metadata.possibly_contaminated, false);
  assert.deepEqual(result.summary.metadata.warnings, []);
  assert.equal(
    byQuery.get('Please run demo-skill on my project')?.errored_runs,
    1,
  );
  assert.equal(
    byQuery.get('Please run demo-skill on my project')?.trigger_rate,
    null,
  );
  assert.equal(
    byQuery.get('Help me configure demo-skill options')?.errored_runs,
    1,
  );
  assert.equal(result.summary.metrics.errored_queries, 2);
  assert.equal(result.summary.metrics.true_negatives, 1);
  assert.equal(result.summary.metrics.accuracy, 1);
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

test('runSkillTriggers runs runner preflight before allocating the triggers directory', async (t) => {
  const { paths, skillDir, env } = await demoSkill({
    t,
    files: { 'evals/trigger_queries.json': triggerQueries },
  });
  const fake = createFakeRunner();
  let taskCalls = 0;
  const runner: EvalRunner = {
    ...fake,
    preflight() {
      return Promise.reject(new RunnerError('codex binary not found on PATH'));
    },
    async runTask(request) {
      taskCalls += 1;
      return fake.runTask(request);
    },
  };

  await assert.rejects(
    runSkillTriggers({
      skillName: 'demo-skill',
      skillDir,
      evalsRootDir: paths.evalsDir,
      runner,
      env,
    }),
    /codex binary not found/,
  );

  assert.equal(taskCalls, 0);
  assert.equal(await lstatIfExists(join(paths.evalsDir, 'demo-skill')), null);
});

test(
  'runSkillEval grades and cleans up whatever state the agent leaves in the workspace',
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const { paths, skillDir, env } = await demoSkill({
      t,
      files: {
        'evals/evals.json': evalSuite([
          'The output confirms skill execution',
          { type: 'json_valid', path: 'out.json' },
          { type: 'regex', path: 'locked/notes.md', pattern: 'x' },
        ]),
      },
    });
    const fake = createFakeRunner();
    const runner: EvalRunner = {
      ...fake,
      async runTask(request) {
        const result = await fake.runTask(request);
        // A folder where a file is expected, an unreadable folder and a
        // read-only folder with content.
        await writeFiles(request.workdir, {
          'out.json/inner.txt': '{}',
          'locked/notes.md': 'x',
          'readonly/kept.txt': 'kept',
        });
        await chmod(join(request.workdir, 'locked'), 0o000);
        await chmod(join(request.workdir, 'readonly'), 0o500);
        return result;
      },
    };

    const result = await runSkillEval({
      skillName: 'demo-skill',
      skillDir,
      evalsRootDir: paths.evalsDir,
      runner,
      baseline: false,
      paths,
      env,
    });
    const runs = result.benchmark.cases.flatMap((item) => item.runs);
    const evidence = runs[0]?.grading.expectations.map((item) => item.evidence);

    assert.equal(runs.length, 2);
    assert.ok(await lstatIfExists(join(result.iterationDir, 'benchmark.json')));
    assert.equal(
      evidence?.[1],
      '"out.json" in workspace is not a regular file.',
    );
    assert.match(
      evidence?.[2] ?? '',
      /^Could not evaluate assertion: .*EACCES/,
    );
    assert.equal(
      await lstatIfExists(
        join(
          result.iterationDir,
          'eval-case-1',
          'with_skill',
          'run-1',
          'workdir',
        ),
      ),
      null,
    );
  },
);

test('runSkillEval reports a personal Claude skill as with_skill contamination, not baseline contamination', async (t) => {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  const skillDir = join(repoRoot, 'skills', 'demo-skill');
  await writeFiles(skillDir, {
    'SKILL.md': skillSource('demo-skill'),
    'evals/evals.json': JSON.stringify({
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'case-1',
          prompt: 'Process the project',
          expected_output: 'Processed the project',
          assertions: ['The output confirms skill execution'],
        },
      ],
    }),
  });
  await writeFiles(join(paths.claudeHome, 'skills', 'demo-skill'), {
    'SKILL.md': skillSource('demo-skill'),
  });
  const runner: EvalRunner = { ...createFakeRunner(), name: 'claude' };

  const result = await runSkillEval({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    runs: 1,
    baseline: true,
    parallel: 1,
    paths,
    env: isolatedGitEnv(repoRoot),
  });

  assert.equal(result.benchmark.metadata.with_skill_contaminated, true);
  assert.equal(result.benchmark.metadata.baseline_status, 'clean');
});

test('runSkillEval stages competing skills for compareSkills and records side-by-side results', async (t) => {
  const { paths, repoRoot, skillDir, env } = await demoSkill({ t });
  const altSkillDir = join(repoRoot, 'skills', 'alt-skill');
  await writeFiles(altSkillDir, {
    'SKILL.md': skillSource('alt-skill'),
  });
  const stagedChecks: string[] = [];
  const fake = createFakeRunner();
  const runner: EvalRunner = {
    ...fake,
    async runTask(request) {
      const stagedMd = await lstatIfExists(
        join(
          request.workdir,
          '.agents',
          'skills',
          request.skillName,
          'SKILL.md',
        ),
      );
      if (stagedMd?.isFile()) {
        stagedChecks.push(request.skillName);
      }
      return fake.runTask(request);
    },
  };

  const result = await runSkillEval({
    skillName: 'demo-skill',
    skillDir,
    evalsRootDir: paths.evalsDir,
    runner,
    baseline: true,
    compareSkills: [{ skillName: 'alt-skill', skillDir: altSkillDir }],
    paths,
    env,
  });
  const variants = result.benchmark.cases
    .flatMap((item) => item.runs)
    .map((run) => run.variant)
    .sort();

  assert.deepEqual(variants, [
    'compare:alt-skill',
    'compare:alt-skill',
    'with_skill',
    'with_skill',
    'without_skill',
    'without_skill',
  ]);
  assert.deepEqual(result.benchmark.metadata.compare_skills, ['alt-skill']);
  assert.ok(stagedChecks.includes('alt-skill'));
  assert.match(
    result.reportMarkdown,
    /\| `compare:alt-skill` \| 100\.0% ± 0\.0% \|/,
  );
});
