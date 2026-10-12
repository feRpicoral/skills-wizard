import fm from 'front-matter';

import { FrontmatterError } from './errors.ts';

interface FrontmatterDocument {
  data: unknown;
  body: string;
}

interface ParseFrontmatterParams {
  source: string;
  file: string;
}

const extract = fm as unknown as typeof fm.default;
const OPENING = '---\n';

export function parseFrontmatter({
  source,
  file,
}: ParseFrontmatterParams): FrontmatterDocument {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith(OPENING)) {
    throw new FrontmatterError(`${file}: missing YAML frontmatter`);
  }

  let parsed: ReturnType<typeof extract<unknown>>;
  try {
    parsed = extract<unknown>(text);
  } catch (error) {
    throw new FrontmatterError(`${file}: invalid YAML frontmatter`, {
      cause: error,
    });
  }

  if (parsed.frontmatter === undefined) {
    throw new FrontmatterError(`${file}: unterminated YAML frontmatter`);
  }

  return { data: parsed.attributes, body: parsed.body.replace(/^\n+/, '') };
}
