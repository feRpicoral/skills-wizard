import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

import { type Paths, resolvePaths } from '../env.ts';

export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

export async function tempPaths(t: TestContext): Promise<Paths> {
  const home = await tempDir(t);
  return resolvePaths({ HOME: home });
}

interface BlockFixture {
  title?: string;
  summary?: string;
  scopes?: string[];
  defaults?: string[];
  variables?: string[];
  group?: string;
}

export function blockSource(body: string, fixture: BlockFixture = {}): string {
  const lines = [
    '---',
    `title: ${fixture.title ?? 'Title'}`,
    `summary: ${fixture.summary ?? 'Summary'}`,
    ...(fixture.group ? [`group: ${fixture.group}`] : []),
    `scopes: [${(fixture.scopes ?? ['global', 'project']).join(', ')}]`,
    `defaults: [${(fixture.defaults ?? ['global']).join(', ')}]`,
    `variables: [${(fixture.variables ?? []).join(', ')}]`,
    '---',
    '',
    body,
    '',
  ];
  return lines.join('\n');
}

export function indexSource(order: string[], header = '# Rules'): string {
  return [
    'headers:',
    `  global: '${header}'`,
    'groups:',
    '  core: Core',
    '  git: Git',
    'order:',
    ...order.map((id) => `  - ${id}`),
    '',
  ].join('\n');
}
