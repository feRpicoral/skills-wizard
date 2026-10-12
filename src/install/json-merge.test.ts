import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JsonMergeError } from '../errors.ts';
import {
  ensureArrayValues,
  hasArrayValues,
  parseJsonObject,
  removeArrayValues,
  serializeJson,
} from './json-merge.ts';

const FILE = 'settings.json';
const VALUES = ['AGENTS.md', 'GEMINI.md'];

test('parseJsonObject treats a missing or blank file as an empty object', () => {
  assert.deepEqual(parseJsonObject(null, FILE), {});
  assert.deepEqual(parseJsonObject(' \n', FILE), {});
});

test('parseJsonObject refuses files with comments', () => {
  assert.throws(() => parseJsonObject('{ // comment\n}', FILE), JsonMergeError);
});

test('ensureArrayValues creates the key path when it is absent', () => {
  const { doc, added } = ensureArrayValues(
    { theme: 'dark' },
    'context.fileName',
    VALUES,
    FILE,
  );

  assert.deepEqual(doc, {
    theme: 'dark',
    context: { fileName: ['AGENTS.md', 'GEMINI.md'] },
  });
  assert.deepEqual(added, VALUES);
});

test('ensureArrayValues converts a string value and appends only missing values', () => {
  const { doc, added } = ensureArrayValues(
    { context: { fileName: 'GEMINI.md' } },
    'context.fileName',
    VALUES,
    FILE,
  );

  assert.deepEqual(doc, { context: { fileName: ['GEMINI.md', 'AGENTS.md'] } });
  assert.deepEqual(added, ['AGENTS.md']);
});

test('ensureArrayValues rejects a value that is not a string list', () => {
  assert.throws(
    () =>
      ensureArrayValues(
        { context: { fileName: 3 } },
        'context.fileName',
        VALUES,
        FILE,
      ),
    /must be a string or a list of strings/,
  );
});

test('removeArrayValues removes values and prunes empty parents', () => {
  const doc = removeArrayValues(
    { theme: 'dark', context: { fileName: ['AGENTS.md'] } },
    'context.fileName',
    ['AGENTS.md'],
    FILE,
  );

  assert.deepEqual(doc, { theme: 'dark' });
});

test('removeArrayValues keeps values it did not add', () => {
  const doc = removeArrayValues(
    { context: { fileName: ['GEMINI.md', 'AGENTS.md'] } },
    'context.fileName',
    ['AGENTS.md'],
    FILE,
  );

  assert.deepEqual(doc, { context: { fileName: ['GEMINI.md'] } });
});

test('hasArrayValues reports whether every value is present', () => {
  const doc = { context: { fileName: ['AGENTS.md', 'GEMINI.md'] } };

  assert.equal(hasArrayValues(doc, 'context.fileName', VALUES, FILE), true);
  assert.equal(hasArrayValues({}, 'context.fileName', VALUES, FILE), false);
});

test('serializeJson uses two spaces and a trailing newline', () => {
  assert.equal(serializeJson({ a: 1 }), '{\n  "a": 1\n}\n');
});
