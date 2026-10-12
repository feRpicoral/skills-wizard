import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import { BlockLibraryError } from '../errors.ts';
import { parseFrontmatter } from '../frontmatter.ts';

export const SCOPES = ['global', 'project'] as const;
export type Scope = (typeof SCOPES)[number];

export interface Block {
  id: string;
  group: string;
  title: string;
  summary: string;
  scopes: Scope[];
  defaults: Scope[];
  variables: string[];
  body: string;
}

export interface BlockLibrary {
  headers: { global: string };
  groups: Record<string, string>;
  blocks: Block[];
}

export const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

const indexSchema = z.object({
  headers: z.object({ global: z.string().min(1) }),
  groups: z.record(z.string(), z.string().min(1)),
  order: z.array(z.string().regex(/^[a-z]+\/[a-z0-9-]+$/)).min(1),
});

const frontmatterSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  group: z.string().min(1),
  scopes: z.array(z.enum(SCOPES)).min(1),
  defaults: z.array(z.enum(SCOPES)).default([]),
  variables: z.array(z.string()).default([]),
});

export async function loadBlockLibrary(
  blocksDir: string,
): Promise<BlockLibrary> {
  const indexFile = join(blocksDir, 'index.yaml');
  const index = parseIndex(await readFile(indexFile, 'utf8'), indexFile);
  const files = await listMarkdownFiles(blocksDir);
  const ids = new Set(index.order);

  if (ids.size !== index.order.length) {
    throw new BlockLibraryError(`${indexFile}: duplicate entries in order`);
  }
  const unlisted = files.filter((id) => !ids.has(id));
  if (unlisted.length > 0) {
    throw new BlockLibraryError(
      `${indexFile}: blocks missing from order: ${unlisted.join(', ')}`,
    );
  }

  const blocks = await Promise.all(
    index.order.map((id) => loadBlock(blocksDir, id, index.groups)),
  );
  return { headers: index.headers, groups: index.groups, blocks };
}

function parseIndex(source: string, file: string) {
  const result = indexSchema.safeParse(parse(source));
  if (!result.success) {
    throw new BlockLibraryError(`${file}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

async function listMarkdownFiles(blocksDir: string): Promise<string[]> {
  const entries = await readdir(blocksDir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      relative(blocksDir, join(entry.parentPath, entry.name))
        .slice(0, -'.md'.length)
        .split(sep)
        .join('/'),
    )
    .sort();
}

async function loadBlock(
  blocksDir: string,
  id: string,
  groups: Record<string, string>,
): Promise<Block> {
  const file = join(blocksDir, `${id}.md`);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new BlockLibraryError(`${file}: listed in order but unreadable`, {
      cause: error,
    });
  }

  const { data, body } = parseFrontmatter(source, file);
  const result = frontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new BlockLibraryError(`${file}: ${z.prettifyError(result.error)}`);
  }

  const meta = result.data;
  const directory = id.split('/')[0];
  if (meta.group !== directory) {
    throw new BlockLibraryError(
      `${file}: group "${meta.group}" does not match directory "${directory}"`,
    );
  }
  if (!(meta.group in groups)) {
    throw new BlockLibraryError(`${file}: unknown group "${meta.group}"`);
  }
  const invalidDefaults = meta.defaults.filter(
    (scope) => !meta.scopes.includes(scope),
  );
  if (invalidDefaults.length > 0) {
    throw new BlockLibraryError(
      `${file}: defaults outside scopes: ${invalidDefaults.join(', ')}`,
    );
  }

  const content = body.trimEnd();
  const used = [...new Set([...content.matchAll(PLACEHOLDER)].map((m) => m[1]))];
  const undeclared = used.filter(
    (name) => name !== undefined && !meta.variables.includes(name),
  );
  const unused = meta.variables.filter((name) => !used.includes(name));
  if (undeclared.length > 0 || unused.length > 0) {
    throw new BlockLibraryError(
      `${file}: variables must match placeholders (undeclared: ${undeclared.join(', ') || 'none'}, unused: ${unused.join(', ') || 'none'})`,
    );
  }

  return { id, ...meta, body: content };
}
