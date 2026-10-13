import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { EvalError } from '../errors.ts';
import { tempDir, writeFiles } from '../test-support/fixtures.ts';
import {
  loadEvalSuite,
  loadTriggerQueries,
  parseEvalSuite,
  parseTriggerQueries,
  selectTriggerQueries,
  splitTriggerQueries,
} from './cases.ts';

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
        { id: 'dup', prompt: 'One', expected_output: 'One', assertions: ['A'] },
        { id: 'dup', prompt: 'Two', expected_output: 'Two', assertions: ['A'] },
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
          assertions: ['A'],
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
          assertions: ['Done'],
        },
      ],
    }),
  });

  const action = () => loadEvalSuite(skillDir);

  await assert.rejects(action, EvalError);
});

test('loadTriggerQueries and splitTriggerQueries assign each query by its own hash, stratified by class', async (t) => {
  const root = await tempDir(t);
  const skillDir = join(root, 'demo-skill');
  const queries = [
    ...Array.from({ length: 40 }, (_, idx) => ({
      query: `positive query ${idx + 1}`,
      should_trigger: true,
    })),
    ...Array.from({ length: 40 }, (_, idx) => ({
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
  const sortedQueries = (items: readonly { query: string }[]) =>
    items.map((item) => item.query).sort();
  const subsetSplit = splitTriggerQueries(loaded.slice(0, 7));
  const grownSplit = splitTriggerQueries([
    ...loaded,
    { query: 'one more positive query', should_trigger: true },
  ]);
  const trainSet = new Set(firstSplit.train.map((item) => item.query));
  const all = [...firstSplit.train, ...firstSplit.validation];

  assert.equal(all.length, 80);
  assert.equal(new Set(all.map((item) => item.query)).size, 80);
  assert.ok(firstSplit.train.length > 32 && firstSplit.train.length < 64);
  assert.ok(firstSplit.train.some((item) => item.should_trigger));
  assert.ok(firstSplit.train.some((item) => !item.should_trigger));
  assert.ok(firstSplit.validation.some((item) => item.should_trigger));
  assert.ok(firstSplit.validation.some((item) => !item.should_trigger));
  assert.deepEqual(
    sortedQueries(firstSplit.train),
    sortedQueries(reversedSplit.train),
  );
  // Removing or adding queries never moves the others between splits.
  for (const item of subsetSplit.train) assert.ok(trainSet.has(item.query));
  for (const item of subsetSplit.validation) {
    assert.ok(!trainSet.has(item.query));
  }
  for (const item of grownSplit.train) {
    if (item.query !== 'one more positive query') {
      assert.ok(trainSet.has(item.query));
    }
  }
  assert.deepEqual(firstSplit.warnings, []);
  assert.deepEqual(
    sortedQueries(selectTriggerQueries(loaded, 'train')),
    sortedQueries(firstSplit.train),
  );
  assert.equal(
    selectTriggerQueries(loaded, 'validation').length,
    firstSplit.validation.length,
  );
  assert.equal(selectTriggerQueries(loaded, 'all').length, 80);
});

test('splitTriggerQueries warns when a class has fewer than two queries in a split', () => {
  const split = splitTriggerQueries([
    { query: 'run the demo skill', should_trigger: true },
    { query: 'what is the weather', should_trigger: false },
  ]);

  assert.equal(split.train.length + split.validation.length, 2);
  assert.equal(split.warnings.length, 4);
  assert.ok(
    split.warnings.some((item) =>
      /validation split.*should-trigger/.test(item),
    ),
  );
  assert.ok(
    split.warnings.some((item) => /train split.*should-not-trigger/.test(item)),
  );
});

test('parseEvalSuite rejects unsafe case ids, case-insensitive duplicates and cases without assertions', () => {
  const evalCase = (id: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    prompt: 'Run',
    expected_output: 'Done',
    assertions: ['Done'],
    ...extra,
  });
  const invalidSuites = [
    [evalCase('-flag')],
    [evalCase('.hidden')],
    [evalCase('has space')],
    [evalCase('a:b')],
    [evalCase('caf\u00e9')],
    [evalCase('Case-1'), evalCase('case-1')],
    [evalCase('no-assertions', { assertions: [] })],
    [{ id: 'missing', prompt: 'Run', expected_output: 'Done' }],
  ];
  const valid = parseEvalSuite({
    raw: {
      skill_name: 'demo-skill',
      evals: [evalCase('Case_1.v2-a'), evalCase(7)],
    },
  });

  for (const evals of invalidSuites) {
    assert.throws(
      () => parseEvalSuite({ raw: { skill_name: 'demo-skill', evals } }),
      EvalError,
    );
  }
  assert.throws(
    () =>
      parseEvalSuite({
        raw: {
          skill_name: 'demo-skill',
          evals: [evalCase('Case-1'), evalCase('case-1')],
        },
      }),
    /duplicate eval case id "case-1" \(conflicts with "Case-1"\)/,
  );
  assert.deepEqual(
    valid.evals.map((item) => item.id),
    ['Case_1.v2-a', '7'],
  );
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
