import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManagedRegionError } from '../errors.ts';
import {
  excludeMarkers,
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

  assert.equal(content, `${existing}\n${BEGIN}\nrules\n${END}\n`);
});

test('upsertRegion keeps CRLF line endings', () => {
  const content = upsertRegion('# Team\r\n\r\nBe nice.\r\n', 'a\nb');

  assert.equal(
    content,
    `# Team\r\n\r\nBe nice.\r\n\r\n${BEGIN}\r\na\r\nb\r\n${END}\r\n`,
  );
});

test('upsertRegion rejects duplicated markers', () => {
  assert.throws(
    () => upsertRegion(`${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`, 'x'),
    ManagedRegionError,
  );
});

test('upsertRegion rejects an unmatched begin marker', () => {
  assert.throws(() => upsertRegion(`${BEGIN}\na\n`, 'x'), ManagedRegionError);
});

test('upsertRegion rejects an end marker before the begin marker', () => {
  assert.throws(
    () => upsertRegion(`${END}\na\n${BEGIN}\n`, 'x'),
    /end marker appears before begin marker/,
  );
});

test('exclude markers are scoped to one project', () => {
  const first = upsertRegion('*.log\n', '/app/AGENTS.md', {
    markers: excludeMarkers('app'),
  });

  const both = upsertRegion(first, '/web/AGENTS.md', {
    markers: excludeMarkers('web'),
  });

  assert.equal(
    both,
    '*.log\n\n# BEGIN:agents-config app\n/app/AGENTS.md\n# END:agents-config app\n\n# BEGIN:agents-config web\n/web/AGENTS.md\n# END:agents-config web\n',
  );
});

test('removeRegion keeps surrounding content and drops the separator', () => {
  const content = removeRegion(`mine\n\n${BEGIN}\nrules\n${END}\n`);

  assert.equal(content, 'mine\n');
});

test('removeRegion returns an empty string when only the region remains', () => {
  const content = removeRegion(`${BEGIN}\nrules\n${END}\n`);

  assert.equal(content, '');
});

test('upsertRegion keeps the endings of lines outside the region', () => {
  const existing = `a\r\nb\n\n${BEGIN}\nold\n${END}\r\nc\n`;

  const content = upsertRegion(existing, 'new');

  assert.equal(content, `a\r\nb\n\n${BEGIN}\nnew\n${END}\r\nc\n`);
});

test('removing an appended region restores a mixed-ending file', () => {
  const existing = '# Team\r\nmixed\nendings\r\n';

  const restored = removeRegion(upsertRegion(existing, 'rules'));

  assert.equal(restored, existing);
});
