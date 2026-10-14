import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { type Environment, gitEnvironment } from '../env.ts';
import { tempDir, writeFiles } from './fixtures.ts';

const run = promisify(execFile);

export function isolatedGitEnv(home: string): Environment {
  return gitEnvironment({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
  });
}

export interface Upstream {
  url: string;
  head: string;
  commit: (files: Record<string, string>, tag?: string) => Promise<string>;
}

export async function createUpstream(
  t: TestContext,
  files: Record<string, string>,
): Promise<Upstream> {
  const root = await tempDir(t);
  const env = isolatedGitEnv(root);
  const work = join(root, 'work');
  const bare = join(root, 'upstream.git');
  const git = async (cwd: string, args: string[]) =>
    (await run('git', args, { cwd, env })).stdout.trim();
  const commit = async (changes: Record<string, string>, tag?: string) => {
    await writeFiles(work, changes);
    await git(work, ['add', '-A']);
    await git(work, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'change',
    ]);

    if (tag) await git(work, ['tag', tag]);
    return git(work, ['rev-parse', 'HEAD']);
  };

  await mkdir(work);
  await git(work, ['init', '-q', '-b', 'main']);
  const head = await commit(files);
  await git(root, ['clone', '-q', '--bare', work, bare]);
  await git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  await git(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);

  return {
    url: pathToFileURL(bare).href,
    head,
    commit: async (changes, tag) => {
      const sha = await commit(changes, tag);
      await git(work, ['push', '-q', '--tags', bare, 'main']);
      return sha;
    },
  };
}
