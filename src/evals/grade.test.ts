import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import { isolatedGitEnv } from '../test-support/git.ts';
import type { EvalCase } from './cases.ts';
import {
  buildBlindGraderPrompt,
  evaluateScriptedAssertion,
  gradeEvalRun,
  type GradingReport,
  normalizeGraderResults,
  runShellCommand,
  summarizeWorkspace,
  type TimingReport,
} from './grade.ts';
import { createFakeRunner } from './runners/index.ts';
import type { RunnerTaskResult } from './runners/types.ts';

test('evaluateScriptedAssertion checks file_exists, file_absent, regex, json_valid, and command', async (t) => {
  const workdir = await tempDir(t);
  const env = isolatedGitEnv(workdir);
  await writeFiles(workdir, {
    'SKILL.md': '---\nname: demo-skill\n---\n',
    'valid.json': '{"ok":true}\n',
    'broken.json': '{not-json\n',
  });

  const existsPass = await evaluateScriptedAssertion({
    assertion: { type: 'file_exists', path: 'SKILL.md' },
    workdir,
    env,
  });
  const existsFail = await evaluateScriptedAssertion({
    assertion: { type: 'file_exists', path: 'missing.md' },
    workdir,
    env,
  });
  const absentPass = await evaluateScriptedAssertion({
    assertion: { type: 'file_absent', path: 'README.md' },
    workdir,
    env,
  });
  const absentFail = await evaluateScriptedAssertion({
    assertion: { type: 'file_absent', path: 'SKILL.md' },
    workdir,
    env,
  });
  const regexPass = await evaluateScriptedAssertion({
    assertion: {
      type: 'regex',
      path: 'SKILL.md',
      pattern: '^name:\\s+demo-skill$',
      flags: 'm',
    },
    workdir,
    env,
  });
  const regexFail = await evaluateScriptedAssertion({
    assertion: {
      type: 'regex',
      path: 'SKILL.md',
      pattern: '^name:\\s+other$',
      flags: 'm',
    },
    workdir,
    env,
  });
  const jsonPass = await evaluateScriptedAssertion({
    assertion: { type: 'json_valid', path: 'valid.json' },
    workdir,
    env,
  });
  const jsonFail = await evaluateScriptedAssertion({
    assertion: { type: 'json_valid', path: 'broken.json' },
    workdir,
    env,
  });
  const cmdPass = await evaluateScriptedAssertion({
    assertion: { type: 'command', run: 'node -e "process.exit(0)"', expect: 0 },
    workdir,
    env,
  });
  const cmdFail = await evaluateScriptedAssertion({
    assertion: { type: 'command', run: 'node -e "process.exit(2)"', expect: 0 },
    workdir,
    env,
  });

  assert.equal(existsPass.passed, true);
  assert.equal(existsFail.passed, false);
  assert.equal(absentPass.passed, true);
  assert.equal(absentFail.passed, false);
  assert.equal(regexPass.passed, true);
  assert.equal(regexFail.passed, false);
  assert.equal(jsonPass.passed, true);
  assert.equal(jsonFail.passed, false);
  assert.equal(cmdPass.passed, true);
  assert.equal(cmdFail.passed, false);
});

test('normalizeGraderResults marks assertions with empty evidence as failed', () => {
  const assertions = ['First claim', 'Second claim'];
  const rawOutput = {
    results: [
      {
        assertion: 'First claim',
        passed: true,
        evidence: 'Confirmed on line 12 of output.',
      },
      {
        assertion: 'Second claim',
        passed: true,
        evidence: '   ',
      },
    ],
  };

  const results = normalizeGraderResults({ assertions, output: rawOutput });

  assert.equal(results[0]?.passed, true);
  assert.equal(results[1]?.passed, false);
  assert.match(results[1]?.evidence ?? '', /no supporting evidence/i);
});

test('gradeEvalRun evaluates scripted assertions before blind grader and writes grading.json and timing.json', async (t) => {
  const root = await tempDir(t);
  const workdir = join(root, 'workdir');
  const runDir = join(root, 'run');
  await writeFiles(workdir, {
    'output.json': '{"configured":true}\n',
  });
  let capturedGraderPrompt = '';
  const runner = createFakeRunner({
    onGrader(request) {
      capturedGraderPrompt = request.prompt;
      return {
        output: {
          results: [
            {
              assertion: 'Response explains the configuration change',
              passed: true,
              evidence: 'Agent stated it updated output.json.',
            },
            {
              assertion: 'Response includes unsupported claim',
              passed: true,
              evidence: '',
            },
          ],
        },
      };
    },
  });

  const { grading, timing } = await gradeEvalRun({
    evalCase: {
      id: 'case-1',
      prompt: 'Configure output.json',
      expected_output: 'Valid output.json and explanation',
      files: [],
      assertions: [
        'Response explains the configuration change',
        'Response includes unsupported claim',
        { type: 'json_valid', path: 'output.json' },
        {
          type: 'command',
          run: 'node -e "require(\\"node:fs\\").writeFileSync(\\"scripted-ran.txt\\", \\"yes\\")"',
          expect: 0,
        },
      ],
    },
    workdir,
    runDir,
    taskResult: {
      response: 'Updated output.json with configured: true.',
      triggered: true,
      durationMs: 1500,
      usage: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
      exitCode: 0,
      timedOut: false,
      rawStdout: '',
      rawStderr: '',
    },
    runner,
    timeoutSeconds: 30,
    env: isolatedGitEnv(root),
  });
  const diskGrading = JSON.parse(
    await readFile(join(runDir, 'grading.json'), 'utf8'),
  ) as GradingReport;
  const diskTiming = JSON.parse(
    await readFile(join(runDir, 'timing.json'), 'utf8'),
  ) as TimingReport;

  assert.equal(capturedGraderPrompt.includes('with_skill'), false);
  assert.equal(capturedGraderPrompt.includes('without_skill'), false);
  assert.match(capturedGraderPrompt, /scripted-ran\.txt/);
  assert.equal(grading.summary.total, 4);
  assert.equal(grading.summary.passed, 3);
  assert.equal(grading.summary.failed, 1);
  assert.deepEqual(diskGrading, grading);
  assert.deepEqual(diskTiming, timing);
  assert.equal(diskTiming.duration_ms, 1500);
  assert.equal(diskTiming.total_tokens, 280);
});

function completedTask(
  overrides: Partial<RunnerTaskResult> = {},
): RunnerTaskResult {
  return {
    response: 'Wrote notes.md with the summary.',
    triggered: true,
    durationMs: 1200,
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    exitCode: 0,
    timedOut: false,
    rawStdout: '',
    rawStderr: '',
    ...overrides,
  };
}

const mixedCase: EvalCase = {
  id: 'mixed',
  prompt: 'Summarize into notes.md',
  expected_output: 'notes.md with a summary',
  files: [],
  assertions: [
    'The response mentions notes.md',
    { type: 'file_exists', path: 'notes.md' },
  ],
};

test('gradeEvalRun fails every assertion without calling the grader when the agent run failed', async (t) => {
  const root = await tempDir(t);
  const workdir = join(root, 'workdir');
  await writeFiles(workdir, { 'notes.md': 'summary\n' });
  let graderCalls = 0;
  const runner = createFakeRunner({
    onGrader() {
      graderCalls += 1;
      return {};
    },
  });

  const errored = await gradeEvalRun({
    evalCase: mixedCase,
    workdir,
    runDir: join(root, 'run-error'),
    taskResult: completedTask({
      error: 'claude exited with code 1',
      exitCode: 1,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    }),
    runner,
    timeoutSeconds: 30,
    env: isolatedGitEnv(root),
  });
  const timedOut = await gradeEvalRun({
    evalCase: mixedCase,
    workdir,
    runDir: join(root, 'run-timeout'),
    taskResult: completedTask({ timedOut: true, exitCode: 124 }),
    runner,
    timeoutSeconds: 30,
    env: isolatedGitEnv(root),
  });
  const diskTiming = JSON.parse(
    await readFile(join(root, 'run-error', 'timing.json'), 'utf8'),
  ) as TimingReport;

  assert.equal(graderCalls, 0);
  assert.equal(errored.grading.summary.passed, 0);
  assert.equal(errored.grading.summary.total, 2);
  assert.deepEqual(
    errored.grading.expectations.map((item) => item.evidence),
    [
      'Agent run failed: claude exited with code 1',
      'Agent run failed: claude exited with code 1',
    ],
  );
  assert.equal(errored.timing.error, 'claude exited with code 1');
  assert.equal(errored.timing.exit_code, 1);
  assert.equal(errored.timing.usage_reported, false);
  assert.deepEqual(diskTiming, errored.timing);
  assert.equal(timedOut.timing.timed_out, true);
  assert.equal(timedOut.timing.error, 'Timed out after 30s');
  assert.equal(timedOut.timing.usage_reported, true);
  assert.match(
    timedOut.grading.expectations[0]?.evidence ?? '',
    /^Agent run failed: Timed out after 30s$/,
  );
});

test('gradeEvalRun marks string assertions failed when the grader throws and keeps scripted results', async (t) => {
  const root = await tempDir(t);
  const workdir = join(root, 'workdir');
  await writeFiles(workdir, { 'notes.md': 'summary\n' });
  const runner = createFakeRunner({
    onGrader() {
      throw new Error('grader returned no structured output');
    },
  });

  const { grading, timing } = await gradeEvalRun({
    evalCase: mixedCase,
    workdir,
    runDir: join(root, 'run'),
    taskResult: completedTask({ usageReported: false }),
    runner,
    timeoutSeconds: 30,
    env: isolatedGitEnv(root),
  });

  assert.equal(grading.expectations[0]?.passed, false);
  assert.equal(
    grading.expectations[0]?.evidence,
    'Grader error: grader returned no structured output',
  );
  assert.equal(grading.expectations[1]?.passed, true);
  assert.equal(timing.error, undefined);
  assert.equal(timing.usage_reported, false);
});

test('gradeEvalRun runs the grader in an empty folder outside the task workspace', async (t) => {
  const root = await tempDir(t);
  const workdir = join(root, 'workdir');
  const runDir = join(root, 'run');
  await writeFiles(workdir, { 'notes.md': 'summary\n' });
  await writeFiles(join(runDir, 'grader-cwd'), { 'stale.txt': 'old\n' });
  let graderDir = '';
  let graderDirEntries: string[] = [];
  const runner = createFakeRunner({
    async onGrader(request) {
      graderDir = request.workdir;
      graderDirEntries = await readdir(request.workdir);
      return {};
    },
  });

  await gradeEvalRun({
    evalCase: mixedCase,
    workdir,
    runDir,
    taskResult: completedTask(),
    runner,
    timeoutSeconds: 30,
    env: isolatedGitEnv(root),
  });

  assert.equal(graderDir, join(runDir, 'grader-cwd'));
  assert.deepEqual(graderDirEntries, []);
});

test('normalizeGraderResults matches verbatim text first, falls back to position only when counts match, and fails closed otherwise', () => {
  const assertions = ['Alpha holds', 'Beta holds', 'Gamma holds'];
  const result = (assertion: string, passed = true) => ({
    assertion,
    passed,
    evidence: `Evidence for ${assertion}`,
  });

  const reordered = normalizeGraderResults({
    assertions,
    output: {
      results: [
        result('Gamma holds'),
        result('Alpha holds', false),
        result('Beta holds'),
      ],
    },
  });
  const paraphrased = normalizeGraderResults({
    assertions,
    output: {
      results: [
        result('Alpha holds', false),
        result('beta is true'),
        result('gamma is true'),
      ],
    },
  });
  const missing = normalizeGraderResults({
    assertions,
    output: { results: [result('alpha paraphrase'), result('Beta holds')] },
  });
  const slotTaken = normalizeGraderResults({
    assertions: ['Alpha holds', 'Beta holds'],
    output: { results: [result('Beta holds'), result('something else')] },
  });
  const wrongShape = normalizeGraderResults({
    assertions,
    output: { verdicts: [] },
  });
  const badItems = normalizeGraderResults({
    assertions: ['Alpha holds'],
    output: { results: [{ assertion: 'Alpha holds', passed: 'yes' }] },
  });

  assert.deepEqual(
    reordered.map((item) => [item.text, item.passed]),
    [
      ['Alpha holds', false],
      ['Beta holds', true],
      ['Gamma holds', true],
    ],
  );
  assert.deepEqual(
    paraphrased.map((item) => item.evidence),
    [
      'Evidence for Alpha holds',
      'Evidence for beta is true',
      'Evidence for gamma is true',
    ],
  );
  assert.equal(missing[0]?.passed, false);
  assert.match(missing[0]?.evidence ?? '', /^Malformed grader output: /);
  assert.equal(missing[1]?.passed, true);
  assert.match(missing[2]?.evidence ?? '', /^Malformed grader output: /);
  assert.match(slotTaken[0]?.evidence ?? '', /^Malformed grader output: /);
  assert.equal(slotTaken[1]?.passed, true);
  for (const item of [...wrongShape, ...badItems]) {
    assert.equal(item.passed, false);
    assert.match(item.evidence, /^Malformed grader output: /);
  }
});

test('normalizeGraderResults downgrades passing results whose quote is not in the graded material', () => {
  const evidenceText = 'Agent said:\n  Created   notes.md\nwith a summary.';
  const results = normalizeGraderResults({
    assertions: ['Creates notes', 'Mentions tests', 'No quote', 'Fails'],
    output: {
      results: [
        {
          assertion: 'Creates notes',
          passed: true,
          evidence: 'The agent created it.',
          quote: 'Created notes.md',
        },
        {
          assertion: 'Mentions tests',
          passed: true,
          evidence: 'The agent ran tests.',
          quote: 'All 12 tests passed',
        },
        {
          assertion: 'No quote',
          passed: true,
          evidence: 'Implied by the response.',
          quote: '',
        },
        {
          assertion: 'Fails',
          passed: false,
          evidence: 'Not done.',
          quote: 'made up',
        },
      ],
    },
    evidenceText,
  });

  assert.deepEqual(
    results.map((item) => item.passed),
    [true, false, true, false],
  );
  assert.match(results[1]?.evidence ?? '', /^Unverified evidence: /);
  assert.match(results[1]?.evidence ?? '', /The agent ran tests\./);
  assert.equal(results[3]?.evidence, 'Not done.');
});

test('buildBlindGraderPrompt describes the output contract and asks for verbatim assertion text', () => {
  const prompt = buildBlindGraderPrompt({
    evalCase: mixedCase,
    response: 'done',
    workspaceSummary: [],
    stringAssertions: ['The response mentions notes.md'],
  });

  assert.match(
    prompt,
    /\{"results": \[\{"assertion": string, "passed": boolean, "evidence": string, "quote": string\}\]\}/,
  );
  assert.match(prompt, /verbatim/);
  assert.match(
    prompt,
    /<assertions>\n\[\n {2}"The response mentions notes\.md"\n\]/,
  );
});

test('summarizeWorkspace skips build, vendor and binary content and lists files it cut short', async (t) => {
  const workdir = await tempDir(t);
  await writeFiles(workdir, {
    'a-small.txt': 'small text\n',
    'b-large.txt': 'x'.repeat(20_000),
    'c-later.txt': 'later file\n',
    'node_modules/pkg/index.js': 'vendored\n',
    'dist/bundle.js': 'built\n',
    'vendor/lib.go': 'vendored\n',
  });
  await writeFile(
    join(workdir, 'a-image.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
  );

  const summary = await summarizeWorkspace({ workdir, budget: 8_080 });
  const text = summary.join('\n\n');

  assert.match(text, /--- a-small\.txt ---\nsmall text/);
  assert.match(text, /--- b-large\.txt \(truncated, 20000 bytes\) ---/);
  assert.match(text, /--- a-image\.png \(binary, 6 bytes\) ---/);
  assert.doesNotMatch(text, /vendored|built/);
  assert.doesNotMatch(text, /later file/);
  assert.match(
    text,
    /--- files not shown in full \(summary limit\) ---\nb-large\.txt \(20000 bytes, truncated\)\nc-later\.txt \(11 bytes, omitted\)/,
  );
  assert.ok(text.length < 10_000);
});

test('runShellCommand passes only the given environment', async (t) => {
  const cwd = await tempDir(t);

  const result = await runShellCommand({
    command: 'printf "%s|%s" "$EVAL_MARKER" "$HOME"',
    cwd,
    env: { PATH: '/usr/bin:/bin', EVAL_MARKER: 'from-env' },
  });

  assert.equal(result.stdout, 'from-env|');
});

test('runShellCommand settles when the shell exits even if a background child keeps the pipes open', async (t) => {
  const cwd = await tempDir(t);
  const started = Date.now();

  const result = await runShellCommand({
    command: 'sleep 30 & echo started',
    cwd,
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 20_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /started/);
  assert.ok(Date.now() - started < 10_000);
});

test('runShellCommand kills the whole process group on timeout', async (t) => {
  const cwd = await tempDir(t);
  const started = Date.now();

  const result = await runShellCommand({
    command: 'sleep 30 & echo $! > child.pid; wait',
    cwd,
    env: { PATH: '/usr/bin:/bin' },
    timeoutMs: 300,
  });
  const childPid = Number(
    (await readFile(join(cwd, 'child.pid'), 'utf8')).trim(),
  );
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      alive = false;
    }
  }

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(alive, false);
});
