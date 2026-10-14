/* eslint-disable no-control-regex -- these tests match ANSI escape codes */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderBanner, stripAnsi } from './banner.ts';

const BASE = {
  title: 'skills-wizard',
  version: '1.2.3',
  tagline: 'Instructions for every agent',
};

test('the true-color banner paints the wizard and a gradient title', () => {
  const banner = renderBanner({ ...BASE, colorDepth: 24 });
  const visible = stripAnsi(banner);

  assert.match(banner, /\x1b\[38;2;\d+;\d+;\d+m▀/);
  assert.match(banner, /\x1b\[1m\x1b\[38;2;167;139;250ms/);
  assert.match(visible, /skills-wizard {2}v1\.2\.3/);
  assert.match(visible, /Instructions for every agent/);
  assert.match(visible, /esc to go back/);
});

test('256-color terminals get palette colors and no true-color codes', () => {
  const banner = renderBanner({ ...BASE, colorDepth: 8 });

  assert.match(banner, /\x1b\[38;5;\d+m/);
  assert.doesNotMatch(banner, /;2;\d+;\d+;\d+m/);
});

test('16-color terminals get ASCII art with basic styling', () => {
  const banner = renderBanner({ ...BASE, colorDepth: 4 });

  assert.doesNotMatch(banner, /[▀▄]/);
  assert.doesNotMatch(banner, /;5;\d+m|;2;\d+;\d+;\d+m/);
  assert.match(banner, /\x1b\[1;35mskills-wizard/);
});

test('monochrome terminals get plain ASCII without escape codes', () => {
  const banner = renderBanner({ ...BASE, colorDepth: 1 });

  assert.doesNotMatch(banner, /\x1b/);
  assert.doesNotMatch(banner, /[▀▄]/);
  assert.match(banner, /\(o {2}o\)/);
  assert.match(banner, /skills-wizard {2}v1\.2\.3/);
});

test('the title sits beside the art, or below it on narrow terminals', () => {
  const wide = stripAnsi(renderBanner({ ...BASE, colorDepth: 24 }))
    .split('\n')
    .find((line) => line.includes('skills-wizard'));
  const narrow = stripAnsi(
    renderBanner({ ...BASE, colorDepth: 24, columns: 40 }),
  )
    .split('\n')
    .find((line) => line.includes('skills-wizard'));

  assert.match(wide ?? '', /▀.*skills-wizard/);
  assert.equal(narrow, '  skills-wizard  v1.2.3');
});

test('every banner line fits the width it was given', () => {
  for (const colorDepth of [1, 4, 8, 24]) {
    const lines = stripAnsi(renderBanner({ ...BASE, colorDepth })).split('\n');
    const longest = Math.max(...lines.map((line) => line.length));
    const banner = renderBanner({ ...BASE, colorDepth, columns: longest });

    assert.equal(
      stripAnsi(banner),
      lines.join('\n'),
      `depth ${colorDepth} should stay side by side at ${longest} columns`,
    );
  }
});
