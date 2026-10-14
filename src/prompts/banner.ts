type Rgb = readonly [number, number, number];

// One character per pixel; `.` is transparent. Two sprite rows share one
// terminal row through the upper half block, so 24 rows render as 12 lines.
// A grey wizard with a floppy pointed hat, a long white beard and a hooked
// staff, drawn in the style of classic pixel-art sprites.
const WIZARD_SPRITE = [
  '..............hHHHHh....',
  '........*....hHHHHHHHd..',
  '..ttt.......hHHHHd..HHd.',
  '.t...t......hHHHd....Hd.',
  '.t...T.....hHHHHd.......',
  '.....T.....hHHHHHd....*.',
  '.....T....hHHHHHHd......',
  '.....T....hHHHHHHHd.....',
  '.....T...hHHHHHHHHd.....',
  '.....T..ddddddddddddd...',
  '.....T.hHHHHHHHHHHHHHHd.',
  '.....T....SSSSSSSd......',
  '.....T....SKSSSKSd......',
  '.....T...wWSSNSSWw......',
  '....SSS.RwWWWWWWWwR.....',
  '....SSSRRWWWWWWWWWRR....',
  '.....TRRRWWWWWWWWWRRr...',
  '.....TRRRRWWWWWWWRRRr...',
  '.....T.RRRRWWWWWRRRRr...',
  '.....T.RRRRRWWWRRRRRr...',
  '.....T.RRRRRRWRRRRRRr...',
  '.....T.RRRRRRRRRRRRRr...',
  '.....T.rrrrRRRRRRrrrr...',
  '.....T..dd........dd....',
] as const;

const SPRITE_WIDTH = WIZARD_SPRITE[0].length;

const PALETTE: Readonly<Record<string, Rgb>> = {
  H: [128, 120, 112],
  h: [170, 162, 152],
  d: [72, 66, 62],
  S: [244, 196, 160],
  N: [222, 150, 120],
  K: [31, 41, 55],
  W: [248, 248, 248],
  w: [205, 210, 216],
  R: [134, 128, 122],
  r: [92, 88, 84],
  T: [124, 74, 38],
  t: [168, 108, 60],
  '*': [103, 232, 249],
};

// Shown when the terminal has fewer than 256 colors (or NO_COLOR is set).
const PLAIN_WIZARD = String.raw`
               __
            _.'  '.
  .-.     .'   .-. \
 (   )   /    /   '
  '| |  /    /
   | | /____/__
   | | ==========
   | |   (o  o)
  (___) /\vvvv/\
   | | /  \vv/  \
   | |/____\/____\
   | |   |_|  |_|
`
  .split('\n')
  .slice(1, -1);

const PLAIN_WIDTH = Math.max(...PLAIN_WIZARD.map((line) => line.length));

const TITLE_GRADIENT: readonly Rgb[] = [
  [167, 139, 250],
  [96, 165, 250],
  [34, 211, 238],
];

const RESET = '\x1b[0m';
const HINT = '↑/↓ to move · enter to select · esc to go back';
const GAP = '   ';
const MARGIN = '  ';

function to256([red, green, blue]: Rgb): number {
  const level = (value: number) => Math.round((value / 255) * 5);

  return 16 + 36 * level(red) + 6 * level(green) + level(blue);
}

function colorCode(rgb: Rgb, colorDepth: number, layer: 'fg' | 'bg'): string {
  const base = layer === 'fg' ? 38 : 48;

  if (colorDepth >= 24) return `\x1b[${base};2;${rgb.join(';')}m`;

  return `\x1b[${base};5;${to256(rgb)}m`;
}

function pixelAt(row: string | undefined, column: number): Rgb | undefined {
  const key = row?.[column];

  return key === undefined ? undefined : PALETTE[key];
}

function halfBlock(
  top: Rgb | undefined,
  bottom: Rgb | undefined,
  colorDepth: number,
): string {
  if (top && bottom) {
    return `${colorCode(top, colorDepth, 'fg')}${colorCode(bottom, colorDepth, 'bg')}▀${RESET}`;
  }

  if (top) return `${colorCode(top, colorDepth, 'fg')}▀${RESET}`;

  if (bottom) return `${colorCode(bottom, colorDepth, 'fg')}▄${RESET}`;

  return ' ';
}

function renderSprite(colorDepth: number): string[] {
  const lines: string[] = [];

  for (let row = 0; row < WIZARD_SPRITE.length; row += 2) {
    const top = WIZARD_SPRITE[row];
    const bottom = WIZARD_SPRITE[row + 1];
    let line = '';

    for (let column = 0; column < SPRITE_WIDTH; column += 1) {
      line += halfBlock(
        pixelAt(top, column),
        pixelAt(bottom, column),
        colorDepth,
      );
    }

    lines.push(line);
  }

  return lines;
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const channel = (index: 0 | 1 | 2) =>
    Math.round(from[index] + (to[index] - from[index]) * amount);

  return [channel(0), channel(1), channel(2)];
}

function gradientColor(position: number): Rgb {
  const scaled = position * (TITLE_GRADIENT.length - 1);
  const index = Math.min(Math.floor(scaled), TITLE_GRADIENT.length - 2);
  const from = TITLE_GRADIENT[index]!;
  const to = TITLE_GRADIENT[index + 1]!;

  return mix(from, to, scaled - index);
}

function gradientText(text: string, colorDepth: number): string {
  const characters = [...text];
  const last = Math.max(characters.length - 1, 1);
  const painted = characters.map(
    (character, index) =>
      `${colorCode(gradientColor(index / last), colorDepth, 'fg')}${character}`,
  );

  return `\x1b[1m${painted.join('')}${RESET}`;
}

interface Palette {
  art: string[];
  artWidth: number;
  title: (text: string) => string;
  dim: (text: string) => string;
}

function paletteFor(colorDepth: number): Palette {
  if (colorDepth >= 8) {
    return {
      art: renderSprite(colorDepth),
      artWidth: SPRITE_WIDTH,
      title: (text) => gradientText(text, colorDepth),
      dim: (text) => `\x1b[2m${text}${RESET}`,
    };
  }

  // 16-color terminals keep the ASCII art but still get basic ANSI styling.
  if (colorDepth >= 4) {
    return {
      art: PLAIN_WIZARD.map((line) => `\x1b[90m${line}${RESET}`),
      artWidth: PLAIN_WIDTH,
      title: (text) => `\x1b[1;35m${text}${RESET}`,
      dim: (text) => `\x1b[2m${text}${RESET}`,
    };
  }

  return {
    art: PLAIN_WIZARD,
    artWidth: PLAIN_WIDTH,
    title: (text) => text,
    dim: (text) => text,
  };
}

// The art lines are padded by their visible width, which is known up front:
// sprite lines are exactly SPRITE_WIDTH cells and plain lines are raw ASCII.
function artLineWidth(line: string, colorDepth: number): number {
  if (colorDepth >= 8) return SPRITE_WIDTH;

  return stripAnsi(line).length;
}

/** Removes ANSI escape sequences, leaving only the visible characters. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface RenderBannerParams {
  title: string;
  version: string;
  tagline: string;
  /** Terminal color depth in bits, as reported by `tty.WriteStream#getColorDepth`. */
  colorDepth: number;
  /** Terminal width in columns. Narrow terminals get the text below the art. */
  columns?: number;
}

/**
 * Renders the launch banner: a pixel-art wizard with the title, version and
 * tagline beside it.
 *
 * Uses 24-bit color when available and falls back to the 256-color palette.
 * Terminals with fewer colors get ASCII art (with basic ANSI styling on
 * 16-color terminals and none at all on monochrome ones).
 */
export function renderBanner({
  title,
  version,
  tagline,
  colorDepth,
  columns,
}: RenderBannerParams): string {
  const { art, artWidth, title: paintTitle, dim } = paletteFor(colorDepth);
  const text = [
    `${paintTitle(title)}  ${dim(`v${version}`)}`,
    tagline,
    '',
    dim(HINT),
  ];
  const textWidth = Math.max(...text.map((line) => stripAnsi(line).length), 0);
  const sideBySideWidth = MARGIN.length + artWidth + GAP.length + textWidth;

  if (columns !== undefined && columns < sideBySideWidth) {
    const stacked = [...art, '', ...text].map((line) =>
      `${MARGIN}${line}`.trimEnd(),
    );

    return `\n${stacked.join('\n')}\n`;
  }

  const offset = Math.max(0, Math.floor((art.length - text.length) / 2));
  const lines = art.map((line, index) => {
    const padding = ' '.repeat(artWidth - artLineWidth(line, colorDepth));
    const side = text[index - offset] ?? '';

    return `${MARGIN}${line}${padding}${GAP}${side}`.trimEnd();
  });

  return `\n${lines.join('\n')}\n`;
}
