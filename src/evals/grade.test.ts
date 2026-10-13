import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  evaluateScriptedAssertion,
  gradeEvalRun,
  type GradingReport,
  normalizeGraderResults,
  type TimingReport,
} from './grade.ts';
import { createFakeRunner } from './runners/index.ts';

test('evaluateScriptedAssertion checks file_exists, file_absent, regex, json_valid, and command', async (t) => {
  const workdir = await tempDir(t);
  await writeFiles(workdir, {
    'SKILL.md': '---\nname: demo-skill\n---\n',
    'valid.json': '{"ok":true}\n',
    'broken.json': '{not-json\n',
  });

  const existsPass = await evaluateScriptedAssertion({
    assertion: { type: 'file_exists', path: 'SKILL.md' },
    workdir,
  });
  const existsFail = await evaluateScriptedAssertion({
    assertion: { type: 'file_exists', path: 'missing.md' },
    workdir,
  });
  const absentPass = await evaluateScriptedAssertion({
    assertion: { type: 'file_absent', path: 'README.md' },
    workdir,
  });
  const absentFail = await evaluateScriptedAssertion({
    assertion: { type: 'file_absent', path: 'SKILL.md' },
    workdir,
  });
  const regexPass = await evaluateScriptedAssertion({
    assertion: {
      type: 'regex',
      path: 'SKILL.md',
      pattern: '^name:\\s+demo-skill$',
      flags: 'm',
    },
    workdir,
  });
  const regexFail = await evaluateScriptedAssertion({
    assertion: {
      type: 'regex',
      path: 'SKILL.md',
      pattern: '^name:\\s+other$',
      flags: 'm',
    },
    workdir,
  });
  const jsonPass = await evaluateScriptedAssertion({
    assertion: { type: 'json_valid', path: 'valid.json' },
    workdir,
  });
  const jsonFail = await evaluateScriptedAssertion({
    assertion: { type: 'json_valid', path: 'broken.json' },
    workdir,
  });
  const cmdPass = await evaluateScriptedAssertion({
    assertion: { type: 'command', run: 'node -e "process.exit(0)"', expect: 0 },
    workdir,
  });
  const cmdFail = await evaluateScriptedAssertion({
    assertion: { type: 'command', run: 'node -e "process.exit(2)"', expect: 0 },
    workdir,
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

  const results = normalizeGraderResults(assertions, rawOutput);

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
