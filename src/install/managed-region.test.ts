import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManagedRegionError } from '../errors.ts';
import {
  excludeMarkers,
  gitignorePattern,
  removeRegion,
  upsertRegion,
} from './managed-region.ts';

const BEGIN = '<!-- BEGIN:skills-wizard -->';
const END = '<!-- END:skills-wizard -->';

test('upsertRegion creates a file with the preamble and region', () => {
  const content = upsertRegion({
    existing: null,
    body: 'rules\n',
    preamble: '# App',
  });

  assert.equal(content, `# App\n\n${BEGIN}\nrules\n${END}\n`);
});

test('upsertRegion replaces only the managed region', () => {
  const existing = `# App\n\nmine\n\n${BEGIN}\nold\n${END}\n\nafter\n`;

  const content = upsertRegion({ existing, body: 'new' });

  assert.equal(content, `# App\n\nmine\n\n${BEGIN}\nnew\n${END}\n\nafter\n`);
});

test('upsertRegion appends a region after content that has no markers', () => {
  const existing =
    '<!-- BEGIN:nextjs-agent-rules -->\nnext\n<!-- END:nextjs-agent-rules -->\n';

  const content = upsertRegion({ existing, body: 'rules' });

  assert.equal(content, `${existing}\n${BEGIN}\nrules\n${END}\n`);
});

test('upsertRegion keeps CRLF line endings', () => {
  const content = upsertRegion({
    existing: '# Team\r\n\r\nBe nice.\r\n',
    body: 'a\nb',
  });

  assert.equal(
    content,
    `# Team\r\n\r\nBe nice.\r\n\r\n${BEGIN}\r\na\r\nb\r\n${END}\r\n`,
  );
});

test('upsertRegion rejects duplicated markers', () => {
  assert.throws(
    () =>
      upsertRegion({
        existing: `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`,
        body: 'x',
      }),
    ManagedRegionError,
  );
});

test('upsertRegion rejects an unmatched begin marker', () => {
  assert.throws(
    () => upsertRegion({ existing: `${BEGIN}\na\n`, body: 'x' }),
    ManagedRegionError,
  );
});

test('upsertRegion rejects an end marker before the begin marker', () => {
  assert.throws(
    () => upsertRegion({ existing: `${END}\na\n${BEGIN}\n`, body: 'x' }),
    /end marker appears before begin marker/,
  );
});

test('exclude markers are scoped to one project', () => {
  const first = upsertRegion({
    existing: '*.log\n',
    body: '/app/AGENTS.md',
    markers: excludeMarkers('app'),
  });

  const both = upsertRegion({
    existing: first,
    body: '/web/AGENTS.md',
    markers: excludeMarkers('web'),
  });

  assert.equal(
    both,
    '*.log\n\n# BEGIN:skills-wizard app\n/app/AGENTS.md\n# END:skills-wizard app\n\n# BEGIN:skills-wizard web\n/web/AGENTS.md\n# END:skills-wizard web\n',
  );
});

test('exclude markers for an id ending in whitespace find their own region', () => {
  const markers = excludeMarkers('app ');
  const first = upsertRegion({
    existing: '*.log\n',
    body: '/app /AGENTS.md',
    markers,
  });

  const again = upsertRegion({
    existing: first,
    body: '/app /AGENTS.md',
    markers,
  });

  assert.equal(again, first);
  assert.equal(removeRegion(again, markers), '*.log\n');
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

  const content = upsertRegion({ existing, body: 'new' });

  assert.equal(content, `a\r\nb\n\n${BEGIN}\nnew\n${END}\r\nc\n`);
});

test('removing an appended region restores a mixed-ending file', () => {
  const existing = '# Team\r\nmixed\nendings\r\n';

  const restored = removeRegion(upsertRegion({ existing, body: 'rules' }));

  assert.equal(restored, existing);
});

test('upsertRegion keeps a byte order mark when the region starts the file', () => {
  const content = upsertRegion({
    existing: `\uFEFF${BEGIN}\nold\n${END}\n`,
    body: 'new',
  });

  assert.equal(content, `\uFEFF${BEGIN}\nnew\n${END}\n`);
});

test('removeRegion keeps a byte order mark when the region starts the file', () => {
  const content = removeRegion(`\uFEFF${BEGIN}\nrules\n${END}\n\n# Team\n`);

  assert.equal(content, '\uFEFF# Team\n');
});

test('upsertRegion strips trailing CRLF line endings from body', () => {
  const content = upsertRegion({
    existing: null,
    body: 'rules\r\n\r\n',
  });

  assert.equal(content, `${BEGIN}\nrules\n${END}\n`);
});

test('excludeMarkers and gitignorePattern reject line breaks', () => {
  assert.throws(() => excludeMarkers('app\n!*'), ManagedRegionError);
  assert.throws(() => excludeMarkers('app\r!*'), ManagedRegionError);
  assert.throws(() => gitignorePattern('app\n!*'), ManagedRegionError);
  assert.throws(() => gitignorePattern('app\r!*'), ManagedRegionError);
});
