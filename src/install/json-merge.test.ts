import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JsonMergeError } from '../errors.ts';
import {
  ensureArrayValues,
  parseJsonObject,
  removeArrayValues,
  serializeJson,
} from './json-merge.ts';

const KEY = 'context.fileName';
const VALUES = ['AGENTS.md', 'GEMINI.md'];

test('parseJsonObject treats a missing file as an empty object', () => {
  assert.deepEqual(parseJsonObject(null), {});
});

test('parseJsonObject treats a blank file as an empty object', () => {
  assert.deepEqual(parseJsonObject(' \n'), {});
});

test('parseJsonObject refuses files with comments', () => {
  assert.throws(() => parseJsonObject('{ // comment\n}'), JsonMergeError);
});

test('ensureArrayValues creates the key path when it is absent', () => {
  const result = ensureArrayValues({
    doc: { theme: 'dark' },
    keyPath: KEY,
    values: VALUES,
  });

  assert.deepEqual(result, {
    doc: { theme: 'dark', context: { fileName: ['AGENTS.md', 'GEMINI.md'] } },
    added: VALUES,
    wasString: false,
  });
});

test('ensureArrayValues converts a string and appends only missing values', () => {
  const result = ensureArrayValues({
    doc: { context: { fileName: 'GEMINI.md' } },
    keyPath: KEY,
    values: VALUES,
  });

  assert.deepEqual(result, {
    doc: { context: { fileName: ['GEMINI.md', 'AGENTS.md'] } },
    added: ['AGENTS.md'],
    wasString: true,
  });
});

test('ensureArrayValues rejects a value that is not a string list', () => {
  assert.throws(
    () =>
      ensureArrayValues({
        doc: { context: { fileName: 3 } },
        keyPath: KEY,
        values: VALUES,
      }),
    /must be a string or a list of strings/,
  );
});

test('removeArrayValues removes values and prunes empty parents', () => {
  const doc = removeArrayValues({
    doc: { theme: 'dark', context: { fileName: ['AGENTS.md'] } },
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: false,
  });

  assert.deepEqual(doc, { theme: 'dark' });
});

test('removeArrayValues restores a value that was originally a string', () => {
  const doc = removeArrayValues({
    doc: { context: { fileName: ['GEMINI.md', 'AGENTS.md'] } },
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: true,
  });

  assert.deepEqual(doc, { context: { fileName: 'GEMINI.md' } });
});

test('serializeJson keeps the indentation and line endings of the file', () => {
  const content = serializeJson({ a: 1 }, '{\r\n    "b": 2\r\n}\r\n');

  assert.equal(content, '{\r\n    "a": 1\r\n}\r\n');
});

test('serializeJson defaults to two spaces for new files', () => {
  assert.equal(serializeJson({ a: 1 }, null), '{\n  "a": 1\n}\n');
});
