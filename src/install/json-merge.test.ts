import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JsonMergeError } from '../errors.ts';
import {
  ensureArrayValues,
  isEmptyJsonObject,
  parseJsonObject,
  removeArrayValues,
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

test('parseJsonObject reads a file that starts with a byte order mark', () => {
  assert.deepEqual(parseJsonObject('\uFEFF{"a":1}'), { a: 1 });
});

test('ensureArrayValues creates a new file with two-space indentation', () => {
  const result = ensureArrayValues({
    existing: null,
    keyPath: KEY,
    values: VALUES,
  });

  assert.deepEqual(result, {
    content:
      '{\n  "context": {\n    "fileName": [\n      "AGENTS.md",\n      "GEMINI.md"\n    ]\n  }\n}\n',
    added: VALUES,
    wasString: false,
    wasEmpty: false,
    createdKeys: 2,
  });
});

test('ensureArrayValues converts a string and appends only missing values', () => {
  const result = ensureArrayValues({
    existing: '{\n  "context": {\n    "fileName": "GEMINI.md"\n  }\n}\n',
    keyPath: KEY,
    values: VALUES,
  });

  assert.deepEqual(result, {
    content:
      '{\n  "context": {\n    "fileName": [\n      "GEMINI.md",\n      "AGENTS.md"\n    ]\n  }\n}\n',
    added: ['AGENTS.md'],
    wasString: true,
    wasEmpty: false,
    createdKeys: 0,
    original: '"GEMINI.md"',
  });
});

test('ensureArrayValues leaves other values exactly as written', () => {
  const existing = '{\n  "ratio": 1.0,\n  "name": "caf\\u00e9"\n}\n';

  const { content } = ensureArrayValues({
    existing,
    keyPath: KEY,
    values: VALUES,
  });

  assert.match(content, /^\{\n {2}"ratio": 1\.0,\n {2}"name": "caf\\u00e9",\n/);
});

test('ensureArrayValues keeps the indentation and line endings of the file', () => {
  const { content } = ensureArrayValues({
    existing: '{\r\n    "context": {}\r\n}\r\n',
    keyPath: KEY,
    values: ['AGENTS.md'],
  });

  assert.equal(
    content,
    '{\r\n    "context": {\r\n        "fileName": [\r\n            "AGENTS.md"\r\n        ]\r\n    }\r\n}\r\n',
  );
});

test('ensureArrayValues counts only the keys it creates', () => {
  const { createdKeys } = ensureArrayValues({
    existing: '{"context":{}}',
    keyPath: KEY,
    values: VALUES,
  });

  assert.equal(createdKeys, 1);
});

test('ensureArrayValues keeps a byte order mark', () => {
  const { content } = ensureArrayValues({
    existing: '\uFEFF{}\n',
    keyPath: KEY,
    values: VALUES,
  });

  assert.ok(content.startsWith('\uFEFF{\n'));
});

test('ensureArrayValues rejects a value that is not a string list', () => {
  assert.throws(
    () =>
      ensureArrayValues({
        existing: '{"context":{"fileName":3}}',
        keyPath: KEY,
        values: VALUES,
      }),
    /must be a string or a list of strings/,
  );
});

test('removeArrayValues removes values and prunes the parents it created', () => {
  const content = removeArrayValues({
    existing:
      '{\n  "theme": "dark",\n  "context": {\n    "fileName": ["AGENTS.md"]\n  }\n}\n',
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: false,
    createdKeys: 2,
  });

  assert.equal(content, '{\n  "theme": "dark"\n}\n');
});

test('removeArrayValues keeps an empty parent it did not create', () => {
  const content = removeArrayValues({
    existing: '{\n  "context": {\n    "fileName": ["AGENTS.md"]\n  }\n}\n',
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: false,
    createdKeys: 1,
  });

  assert.deepEqual(JSON.parse(content), { context: {} });
});

test('removeArrayValues leaves an empty list it did not create', () => {
  const content = removeArrayValues({
    existing: '{"context":{"fileName":["AGENTS.md"]}}',
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: false,
    createdKeys: 0,
  });

  assert.deepEqual(JSON.parse(content), { context: { fileName: [] } });
});

test('removeArrayValues restores a value that was originally a string', () => {
  const existing = '{\n    "context": { "fileName": "GEMINI.md" }\n}\n';
  const { content: installed } = ensureArrayValues({
    existing,
    keyPath: KEY,
    values: ['AGENTS.md'],
  });

  const content = removeArrayValues({
    existing: installed,
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: true,
    createdKeys: 0,
  });

  assert.equal(content, existing);
});

test('removeArrayValues keeps a byte order mark', () => {
  const content = removeArrayValues({
    existing: '\uFEFF{"a":1,"context":{"fileName":["AGENTS.md"]}}',
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: false,
    createdKeys: 2,
  });

  assert.equal(content, '\uFEFF{"a":1}');
});

test('isEmptyJsonObject is true only for an object without keys', () => {
  assert.deepEqual(
    ['{}\n', '{"a":1}'].map((content) => isEmptyJsonObject(content)),
    [true, false],
  );
});

interface RoundTripParams {
  existing: string;
  values?: readonly string[];
}

function roundTrip({ existing, values = VALUES }: RoundTripParams) {
  const installed = ensureArrayValues({ existing, keyPath: KEY, values });
  const removed = removeArrayValues({
    existing: installed.content,
    keyPath: KEY,
    values: installed.added,
    restoreString: installed.wasString,
    createdKeys: installed.createdKeys,
    ...(installed.original === undefined
      ? {}
      : { original: installed.original }),
  });
  return { installed: installed.content, removed };
}

test('ensureArrayValues leaves inline object and array siblings byte for byte', () => {
  const existing =
    '{\n  "mcpServers": { "gh": { "command": "gh", "args": ["mcp"] } },\n  "tags": [1, 2]\n}\n';

  const { installed } = roundTrip({ existing });

  assert.equal(
    installed,
    '{\n  "mcpServers": { "gh": { "command": "gh", "args": ["mcp"] } },\n  "tags": [1, 2],\n  "context": {\n    "fileName": [\n      "AGENTS.md",\n      "GEMINI.md"\n    ]\n  }\n}\n',
  );
});

test('removing the values restores inline object and array siblings byte for byte', () => {
  const existing =
    '{\n  "mcpServers": { "gh": { "command": "gh", "args": ["mcp"] } },\n  "tags": [1, 2]\n}\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing the values restores an empty parent the user created', () => {
  const existing = '{\n  "context": {},\n  "tags": ["a"]\n}\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing the values restores siblings inside the parent object', () => {
  const existing =
    '{\n  "context": {\n    "loader": { "depth": 2 },\n    "dirs": ["a", "b"]\n  }\n}\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing the values restores a single-line file', () => {
  const existing = '{"theme":"dark","list":[1,2]}';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing the values restores a spaced list the user wrote', () => {
  const existing = '{ "context": { "fileName": [ "GEMINI.md" ] } }\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('adding values appends to a multi-line list without reformatting it', () => {
  const existing =
    '{\n  "context": {\n    "fileName": [\n        "GEMINI.md"\n    ]\n  }\n}\n';

  const { installed } = roundTrip({ existing });

  assert.equal(
    installed,
    '{\n  "context": {\n    "fileName": [\n        "GEMINI.md",\n        "AGENTS.md"\n    ]\n  }\n}\n',
  );
});

test('removing the values restores a string with escapes as written', () => {
  const existing = '{"context": {"fileName": "GEM\\u0049NI.md"}}\n';

  const { removed } = roundTrip({ existing, values: ['AGENTS.md'] });

  assert.equal(removed, existing);
});

test('removing the values restores an empty list the user wrote', () => {
  const existing = '{"context": {"fileName": [ ]}}\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing the values restores the whitespace inside a user-created empty parent', () => {
  const existing = '{\n  "context": { }\n}\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing the values restores a root object with only whitespace', () => {
  const existing = '{ }\n';

  const { removed } = roundTrip({ existing });

  assert.equal(removed, existing);
});

test('removing values keeps a list the user changed after the install', () => {
  const { installed } = roundTrip({
    existing: '{"context": {"fileName": [ "GEMINI.md" ]}}',
  });

  const removed = removeArrayValues({
    existing: installed.replace('"GEMINI.md"', '"GEMINI.md", "MINE.md"'),
    keyPath: KEY,
    values: ['AGENTS.md'],
    restoreString: false,
    createdKeys: 0,
    original: '[ "GEMINI.md" ]',
  });

  assert.equal(
    removed,
    '{"context": {"fileName": [ "GEMINI.md", "MINE.md" ]}}',
  );
});
