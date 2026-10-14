import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureArrayValues, removeArrayValues } from './json-merge.ts';

const KEY = 'context.fileName';
const VALUES = ['AGENTS.md', 'GEMINI.md'];

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

test('removeArrayValues removes all duplicate occurrences of added values', () => {
  const removed = removeArrayValues({
    existing:
      '{\n  "context": {\n    "fileName": ["AGENTS.md", "GEMINI.md", "AGENTS.md"]\n  }\n}\n',
    keyPath: KEY,
    values: ['AGENTS.md', 'GEMINI.md'],
    restoreString: false,
    createdKeys: 0,
  });

  assert.deepEqual(JSON.parse(removed), { context: { fileName: [] } });
});
