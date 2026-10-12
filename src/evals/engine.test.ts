import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { lstatIfExists } from '../install/fs.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { isolatedGitEnv } from '../test-support/git.ts';
import {
  regenerateSkillReport,
  runSkillEval,
  runSkillTriggers,
} from './engine.ts';
import { createFakeRunner } from './runners/index.ts';

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
    repoRoot,
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
