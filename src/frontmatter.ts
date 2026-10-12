import { parse } from 'yaml';

import { FrontmatterError } from './errors.ts';

interface FrontmatterDocument {
  data: unknown;
  body: string;
}

const OPENING = '---\n';
const CLOSING = /\n---(\n|$)/;

export function parseFrontmatter(
  source: string,
  file: string,
): FrontmatterDocument {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith(OPENING)) {
    throw new FrontmatterError(`${file}: missing YAML frontmatter`);
  }

  const rest = text.slice(OPENING.length);
  const closing = CLOSING.exec(rest);
  if (!closing) {
    throw new FrontmatterError(`${file}: unterminated YAML frontmatter`);
  }

  let data: unknown;
  try {
    data = parse(rest.slice(0, closing.index));
  } catch (error) {
    throw new FrontmatterError(`${file}: invalid YAML frontmatter`, {
      cause: error,
    });
  }

  const body = rest.slice(closing.index + closing[0].length);
  return { data, body: body.replace(/^\n+/, '') };
}
