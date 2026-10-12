import assert from 'node:assert/strict';
import { test } from 'node:test';

import { joinLines, lineEnding, splitLines } from './lines.ts';

test('splitLines keeps each line ending so joinLines restores the text', () => {
  const content = 'a\r\nb\nc';

  const lines = splitLines(content);

  assert.deepEqual(lines, [
    { text: 'a', eol: '\r\n' },
    { text: 'b', eol: '\n' },
    { text: 'c', eol: '' },
  ]);
  assert.equal(joinLines(lines), content);
});

test('lineEnding picks the ending most lines use', () => {
  const endings = ['a\r\nb\r\nc\n', 'a\r\nb\nc\n'].map(lineEnding);

  assert.deepEqual(endings, ['\r\n', '\n']);
});

test('lineEnding uses LF for a new file', () => {
  const ending = lineEnding(null);

  assert.equal(ending, '\n');
});
