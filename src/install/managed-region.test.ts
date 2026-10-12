import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManagedRegionError } from '../errors.ts';
import { ensureLine, removeLine } from './import-line.ts';
import {
  HASH_MARKERS,
  hasRegion,
  removeRegion,
  upsertRegion,
} from './managed-region.ts';

const BEGIN = '<!-- BEGIN:agents-config -->';
const END = '<!-- END:agents-config -->';

test('upsertRegion creates a file with the preamble and region', () => {
  const content = upsertRegion(null, 'rules\n', { preamble: '# App' });

  assert.equal(content, `# App\n\n${BEGIN}\nrules\n${END}\n`);
});

test('upsertRegion replaces only the managed region', () => {
  const existing = `# App\n\nmine\n\n${BEGIN}\nold\n${END}\n\nafter\n`;

  const content = upsertRegion(existing, 'new');

  assert.equal(content, `# App\n\nmine\n\n${BEGIN}\nnew\n${END}\n\nafter\n`);
});

test('upsertRegion appends a region after content that has no markers', () => {
  const existing =
    '<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n';

  const content = upsertRegion(existing, 'rules');

  assert.equal(
    content,
    `<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n\n${BEGIN}\nrules\n${END}\n`,
  );
});

test('upsertRegion rejects duplicated or unmatched markers', () => {
  assert.throws(
    () => upsertRegion(`${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`, 'x'),
    ManagedRegionError,
  );
  assert.throws(() => upsertRegion(`${BEGIN}\na\n`, 'x'), ManagedRegionError);
  assert.throws(
    () => upsertRegion(`${END}\na\n${BEGIN}\n`, 'x'),
    /end marker appears before begin marker/,
  );
});

test('upsertRegion supports hash markers for git exclude files', () => {
  const content = upsertRegion('*.log\n', 'AGENTS.md', {
    markers: HASH_MARKERS,
  });

  assert.equal(
    content,
    '*.log\n\n# BEGIN:agents-config\nAGENTS.md\n# END:agents-config\n',
  );
});

test('removeRegion keeps surrounding content and drops the separator', () => {
  const existing = `mine\n\n${BEGIN}\nrules\n${END}\n`;

  const content = removeRegion(existing);

  assert.equal(content, 'mine\n');
});

test('removeRegion returns an empty string when only the region remains', () => {
  const content = removeRegion(`${BEGIN}\nrules\n${END}\n`);

  assert.equal(content, '');
});

test('hasRegion detects whether a managed region exists', () => {
  assert.equal(hasRegion(`a\n${BEGIN}\nb\n${END}\n`), true);
  assert.equal(hasRegion('a\n'), false);
});

test('ensureLine creates, keeps or prepends the import line', () => {
  assert.equal(ensureLine(null, '@AGENTS.md'), '@AGENTS.md\n');
  assert.equal(
    ensureLine('@AGENTS.md\nmore\n', '@AGENTS.md'),
    '@AGENTS.md\nmore\n',
  );
  assert.equal(
    ensureLine('# Claude only\n', '@AGENTS.md'),
    '@AGENTS.md\n\n# Claude only\n',
  );
});

test('removeLine drops the import line and its blank separator', () => {
  assert.equal(
    removeLine('@AGENTS.md\n\n# Claude only\n', '@AGENTS.md'),
    '# Claude only\n',
  );
  assert.equal(removeLine('@AGENTS.md\n', '@AGENTS.md'), '');
});
