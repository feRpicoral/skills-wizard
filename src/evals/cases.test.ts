import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { EvalError } from '../errors.ts';
import { validateSkill } from '../skills/validate.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  loadEvalSuite,
  loadTriggerQueries,
  parseEvalSuite,
  parseTriggerQueries,
  selectTriggerQueries,
  splitTriggerQueries,
} from './cases.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

test('loadEvalSuite parses string and scripted assertions and verifies files', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'pdf-rotator');
  await writeFiles(skillDir, {
    'evals/files/sample.txt': 'hello\n',
    'evals/evals.json': JSON.stringify({
      skill_name: 'pdf-rotator',
      evals: [
        {
          id: 'rotate-single',
          prompt: 'Rotate sample.txt',
          expected_output: 'Rotated output file',
          files: ['evals/files/sample.txt'],
          assertions: [
            'The response explains how the rotation was performed',
            { type: 'file_exists', path: 'SKILL.md' },
            { type: 'file_absent', path: 'README.md' },
            {
              type: 'regex',
              path: 'SKILL.md',
              pattern: '^name:\\s+pdf-rotator$',
              flags: 'm',
            },
            { type: 'json_valid', path: 'evals/evals.json' },
            { type: 'command', run: 'node --version' },
          ],
        },
      ],
    }),
  });

  const suite = await loadEvalSuite(skillDir);

  assert.equal(suite.skill_name, 'pdf-rotator');
  assert.equal(suite.evals.length, 1);
  assert.deepEqual(suite.evals[0], {
    id: 'rotate-single',
    prompt: 'Rotate sample.txt',
    expected_output: 'Rotated output file',
    files: ['evals/files/sample.txt'],
    assertions: [
      'The response explains how the rotation was performed',
      { type: 'file_exists', path: 'SKILL.md' },
      { type: 'file_absent', path: 'README.md' },
      {
        type: 'regex',
        path: 'SKILL.md',
        pattern: '^name:\\s+pdf-rotator$',
        flags: 'm',
      },
      { type: 'json_valid', path: 'evals/evals.json' },
      { type: 'command', run: 'node --version', expect: 0 },
    ],
  });
});

test('parseEvalSuite accepts expectations alias and numeric case ids', () => {
  const raw = {
    skill_name: 'demo-skill',
    evals: [
      {
        id: 1,
        prompt: 'Run demo',
        expected_output: 'Demo output',
        expectations: ['Output mentions demo'],
      },
    ],
  };

  const suite = parseEvalSuite({
    raw,
    expectedSkillName: 'demo-skill',
  });

  assert.equal(suite.evals[0]?.id, '1');
  assert.deepEqual(suite.evals[0]?.assertions, ['Output mentions demo']);
});

test('parseEvalSuite rejects invalid regex, duplicate ids, and escaping paths', () => {
  const invalidCases = [
    {
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'bad-regex',
          prompt: 'Test',
          expected_output: 'Result',
          assertions: [
            { type: 'regex', path: 'out.txt', pattern: '[unclosed' },
          ],
        },
      ],
    },
    {
      skill_name: 'demo-skill',
      evals: [
        { id: 'dup', prompt: 'One', expected_output: 'One' },
        { id: 'dup', prompt: 'Two', expected_output: 'Two' },
      ],
    },
    {
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'escape',
          prompt: 'One',
          expected_output: 'One',
          files: ['../secret.txt'],
        },
      ],
    },
    {
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'both-fields',
          prompt: 'One',
          expected_output: 'One',
          assertions: ['A'],
          expectations: ['B'],
        },
      ],
    },
  ];

  const attempt = (raw: unknown) => () => parseEvalSuite({ raw });

  for (const raw of invalidCases) {
    assert.throws(attempt(raw), EvalError);
  }
});

test('loadEvalSuite rejects missing fixture files on disk', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'demo-skill');
  await writeFiles(skillDir, {
    'evals/evals.json': JSON.stringify({
      skill_name: 'demo-skill',
      evals: [
        {
          id: 'missing-file',
          prompt: 'Run',
          expected_output: 'Done',
          files: ['evals/files/missing.txt'],
        },
      ],
    }),
  });

  const action = () => loadEvalSuite(skillDir);

  await assert.rejects(action, EvalError);
});

test('loadTriggerQueries and splitTriggerQueries produce a deterministic 60/40 stratified split', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'demo-skill');
  const queries = [
    ...Array.from({ length: 10 }, (_, idx) => ({
      query: `positive query ${idx + 1}`,
      should_trigger: true,
    })),
    ...Array.from({ length: 10 }, (_, idx) => ({
      query: `negative query ${idx + 1}`,
      should_trigger: false,
    })),
  ];
  await writeFiles(skillDir, {
    'evals/trigger_queries.json': JSON.stringify(queries),
  });

  const loaded = await loadTriggerQueries(skillDir);
  const firstSplit = splitTriggerQueries(loaded);
  const reversedSplit = splitTriggerQueries([...loaded].reverse());

  assert.equal(firstSplit.train.length, 12);
  assert.equal(firstSplit.validation.length, 8);
  assert.equal(
    firstSplit.train.filter((item) => item.should_trigger).length,
    6,
  );
  assert.equal(
    firstSplit.train.filter((item) => !item.should_trigger).length,
    6,
  );
  assert.equal(
    firstSplit.validation.filter((item) => item.should_trigger).length,
    4,
  );
  assert.equal(
    firstSplit.validation.filter((item) => !item.should_trigger).length,
    4,
  );
  assert.deepEqual(firstSplit, reversedSplit);
  assert.equal(selectTriggerQueries(loaded, 'train').length, 12);
  assert.equal(selectTriggerQueries(loaded, 'validation').length, 8);
  assert.equal(selectTriggerQueries(loaded, 'all').length, 20);
});

test('parseTriggerQueries rejects empty arrays, duplicates, and invalid items', () => {
  const invalidInputs: unknown[] = [
    [],
    [
      { query: 'same', should_trigger: true },
      { query: 'same', should_trigger: false },
    ],
    [{ query: '', should_trigger: true }],
  ];

  const attempt = (raw: unknown) => () => parseTriggerQueries(raw);

  for (const raw of invalidInputs) {
    assert.throws(attempt(raw), EvalError);
  }
});

test('all five new first-party skills pass strict validation and eval suite loading', async () => {
  const skillNames = [
    'eslint-configuration',
    'github-repo-setup',
    'nestjs-module',
    'prettier-configuration',
    'supabase-prisma',
  ];

  const results = await Promise.all(
    skillNames.map(async (name) => {
      const dir = join(REPO_ROOT, 'skills', name);
      const report = await validateSkill(dir, { strict: true });
      const suite = await loadEvalSuite(dir);
      const queries = await loadTriggerQueries(dir);
      return {
        name,
        errors: report.errors,
        warnings: report.warnings,
        evalCount: suite.evals.length,
        positiveCount: queries.filter((item) => item.should_trigger).length,
        negativeCount: queries.filter((item) => !item.should_trigger).length,
      };
    }),
  );

  for (const item of results) {
    assert.deepEqual(item.errors, []);
    assert.deepEqual(item.warnings, []);
    assert.equal(item.evalCount, 3);
    assert.equal(item.positiveCount, 10);
    assert.equal(item.negativeCount, 10);
  }
});
