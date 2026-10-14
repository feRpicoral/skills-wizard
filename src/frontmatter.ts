import { parse } from 'yaml';

import { FrontmatterError } from './errors.ts';

interface FrontmatterDocument {
  data: unknown;
  body: string;
}

interface ParseFrontmatterParams {
  source: string;
  file: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFrontmatter({
  source,
  file,
}: ParseFrontmatterParams): FrontmatterDocument {
  const text = source.replace(/\r\n/g, '\n');

  if (!text.startsWith('---\n')) {
    throw new FrontmatterError(`${file}: missing YAML frontmatter`);
  }

  const match = FRONTMATTER.exec(text);

  if (!match) {
    throw new FrontmatterError(`${file}: unterminated YAML frontmatter`);
  }

  try {
    const data: unknown = parse(match[1] ?? '');
    const body = text.slice(match[0].length).replace(/^\n+/, '');

    return { data, body };
  } catch (error) {
    throw new FrontmatterError(`${file}: invalid YAML frontmatter`, {
      cause: error,
    });
  }
}
