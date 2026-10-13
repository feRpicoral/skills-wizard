import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

import which from 'which';
import { stringify } from 'yaml';

import { type Paths, resolvePaths } from '../env.ts';

export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-config-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A directory holding links to only the given executables, for a PATH that
// keeps child processes away from everything else installed on the machine.
export async function tempSearchPath(
  t: TestContext,
  commands: readonly string[],
): Promise<string> {
  const dir = await tempDir(t);
  for (const command of commands) {
    await symlink(await which(command), join(dir, command));
  }
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
  requires?: string[];
  group?: string;
}

export function blockSource(
  body: string,
  {
    title = 'Title',
    summary = 'Summary',
    group,
    scopes = ['global', 'project'],
    defaults = ['global'],
    variables = [],
    requires,
  }: BlockFixture = {},
): string {
  const lines = [
    '---',
    `title: ${title}`,
    `summary: ${summary}`,
    ...(group ? [`group: ${group}`] : []),
    `scopes: [${scopes.join(', ')}]`,
    `defaults: [${defaults.join(', ')}]`,
    `variables: [${variables.join(', ')}]`,
    ...(requires ? [`requires: [${requires.join(', ')}]`] : []),
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

export function skillSource(
  name: string,
  fields: Record<string, unknown> = {},
): string {
  const frontmatter = stringify({
    name,
    description: `Handles ${name} tasks. Use when working on ${name}.`,
    ...fields,
  });
  return `---\n${frontmatter}---\n\nFollow these steps.\n`;
}
