// Renders docs/assets/cli.svg, the terminal screenshot shown in README.md,
// from the real launch banner plus a still of the main menu.
// Usage: yarn readme:screenshot
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildMainMenu, menuOptions } from '../src/commands/menu.ts';
import { renderBanner } from '../src/prompts/banner.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const OUTPUT = join(REPO_ROOT, 'docs', 'assets', 'cli.svg');

const CELL_WIDTH = 9.6;
const CELL_HEIGHT = 20;
const PADDING = 24;
const TOP = 48;
const DEFAULT_FG = '#e5e7eb';

const BASIC = [
  '#1f2937',
  '#ef4444',
  '#22c55e',
  '#eab308',
  '#3b82f6',
  '#a855f7',
  '#06b6d4',
  '#e5e7eb',
];
const BRIGHT = [
  '#6b7280',
  '#f87171',
  '#4ade80',
  '#facc15',
  '#60a5fa',
  '#c084fc',
  '#22d3ee',
  '#ffffff',
];

interface Cell {
  row: number;
  column: number;
  character: string;
  fg: string | undefined;
  bg: string | undefined;
  bold: boolean;
  dim: boolean;
}

function xterm256(code: number): string {
  if (code < 8) return BASIC[code]!;
  if (code < 16) return BRIGHT[code - 8]!;
  if (code >= 232) {
    const value = 8 + (code - 232) * 10;
    return `rgb(${value},${value},${value})`;
  }

  const index = code - 16;
  const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);

  return `rgb(${level(Math.floor(index / 36))},${level(Math.floor(index / 6) % 6)},${level(index % 6)})`;
}

function parseAnsi(input: string): {
  cells: Cell[];
  rows: number;
  columns: number;
} {
  const cells: Cell[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let row = 0;
  let column = 0;
  let columns = 0;

  // eslint-disable-next-line no-control-regex
  for (const match of input.matchAll(/\x1b\[([0-9;]*)m|\n|[^\x1b\n]/gu)) {
    const [token, params] = match;

    if (token === '\n') {
      row += 1;
      column = 0;
      continue;
    }

    if (params !== undefined) {
      const codes = params === '' ? [0] : params.split(';').map(Number);

      for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index]!;

        if (code === 0) {
          fg = bg = undefined;
          bold = dim = false;
        } else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) bold = dim = false;
        else if (code === 39) fg = undefined;
        else if (code === 49) bg = undefined;
        else if (code >= 30 && code <= 37) fg = BASIC[code - 30];
        else if (code >= 90 && code <= 97) fg = BRIGHT[code - 90];
        else if (code >= 40 && code <= 47) bg = BASIC[code - 40];
        else if (code === 38 || code === 48) {
          let color: string;

          if (codes[index + 1] === 2) {
            color = `rgb(${codes[index + 2]},${codes[index + 3]},${codes[index + 4]})`;
            index += 4;
          } else {
            color = xterm256(codes[index + 2] ?? 0);
            index += 2;
          }

          if (code === 38) fg = color;
          else bg = color;
        }
      }

      continue;
    }

    cells.push({ row, column, character: token, fg, bg, bold, dim });
    column += 1;
    columns = Math.max(columns, column);
  }

  return { cells, rows: row + 1, columns };
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function rect(x: number, y: number, height: number, fill: string): string {
  return `<rect x="${x.toFixed(1)}" y="${y}" width="${CELL_WIDTH + 0.4}" height="${height}" fill="${fill}"/>`;
}

function toSvg(input: string): string {
  const { cells, rows, columns } = parseAnsi(input);
  const width = Math.ceil(PADDING * 2 + columns * CELL_WIDTH);
  const height = Math.ceil(TOP + PADDING + rows * CELL_HEIGHT);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="skills-wizard interactive menu">`,
    '<rect width="100%" height="100%" rx="10" fill="#0d1117"/>',
    '<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>',
    `<text x="${width / 2}" y="25" fill="#8b949e" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="13" text-anchor="middle">skills-wizard</text>`,
    '<g font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="16" xml:space="preserve">',
  ];

  for (const cell of cells) {
    const x = PADDING + cell.column * CELL_WIDTH;
    const y = TOP + cell.row * CELL_HEIGHT;

    // Half blocks become two exact rectangles so the pixel art stays crisp.
    if (cell.character === '▀' || cell.character === '▄') {
      const upper = cell.character === '▀' ? cell.fg : cell.bg;
      const lower = cell.character === '▀' ? cell.bg : cell.fg;

      if (upper) parts.push(rect(x, y, CELL_HEIGHT / 2 + 0.4, upper));
      if (lower) {
        parts.push(rect(x, y + CELL_HEIGHT / 2, CELL_HEIGHT / 2 + 0.4, lower));
      }
      continue;
    }

    if (cell.bg) parts.push(rect(x, y, CELL_HEIGHT, cell.bg));
    if (cell.character === ' ') continue;

    const attributes = [
      `x="${x.toFixed(1)}"`,
      `y="${y + 15}"`,
      `fill="${cell.fg ?? DEFAULT_FG}"`,
    ];

    if (cell.bold) attributes.push('font-weight="bold"');
    if (cell.dim) attributes.push('opacity="0.55"');
    parts.push(
      `<text ${attributes.join(' ')}>${escapeXml(cell.character)}</text>`,
    );
  }

  parts.push('</g></svg>', '');

  return parts.join('\n');
}

// A still of the main menu as @clack/prompts draws it, first option active.
function menuPreview(): string {
  const gray = (text: string) => `\x1b[90m${text}\x1b[0m`;
  const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
  const bar = gray('│');
  const menu = buildMainMenu();
  const options = menuOptions(menu, true).map((option, index) =>
    index === 0
      ? `${bar}  \x1b[32m●\x1b[0m ${option.label}${option.hint ? ` ${dim(`(${option.hint})`)}` : ''}`
      : `${bar}  ${dim(`○ ${option.label}`)}`,
  );

  return [
    `${gray('┌')}  Main menu`,
    bar,
    `\x1b[36m◆\x1b[0m  ${menu.message}`,
    ...options,
    `\x1b[36m└\x1b[0m`,
  ].join('\n');
}

const { version } = JSON.parse(
  await readFile(join(REPO_ROOT, 'package.json'), 'utf8'),
) as { version: string };

const banner = renderBanner({
  title: 'skills-wizard',
  version,
  tagline: 'Instructions, skills and MCP servers for every coding agent',
  colorDepth: 24,
});

await writeFile(OUTPUT, toSvg(`${banner}\n${menuPreview()}`));
process.stdout.write(`Wrote ${OUTPUT}\n`);
