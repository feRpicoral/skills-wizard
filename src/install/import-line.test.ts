import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ensureLine, removeLine } from './import-line.ts';

test('ensureLine creates a file with just the line', () => {
  assert.equal(
    ensureLine({ existing: null, line: '@AGENTS.md' }),
    '@AGENTS.md\n',
  );
});

test('ensureLine keeps a file that already has the line', () => {
  const content = ensureLine({
    existing: '@AGENTS.md\nmore\n',
    line: '@AGENTS.md',
  });

  assert.equal(content, '@AGENTS.md\nmore\n');
});

test('ensureLine prepends the line using the file line endings', () => {
  const content = ensureLine({
    existing: '# Claude\r\n',
    line: '@AGENTS.md',
  });

  assert.equal(content, '@AGENTS.md\r\n\r\n# Claude\r\n');
});

test('removeLine drops the line and its blank separator', () => {
  const content = removeLine({
    existing: '@AGENTS.md\n\n# Claude only\n',
    line: '@AGENTS.md',
  });

  assert.equal(content, '# Claude only\n');
});

test('removeLine returns an empty string when only the line remains', () => {
  assert.equal(
    removeLine({ existing: '@AGENTS.md\n', line: '@AGENTS.md' }),
    '',
  );
});

test('removeLine keeps the endings of the other lines', () => {
  const content = removeLine({
    existing: '@AGENTS.md\n\n# Claude\r\nmore\n',
    line: '@AGENTS.md',
  });

  assert.equal(content, '# Claude\r\nmore\n');
});
