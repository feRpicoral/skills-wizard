import { execFile } from 'node:child_process';
import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { type Environment, gitEnvironment } from '../env.ts';
import { EvalError } from '../errors.ts';
import {
  EXECUTABLE_MODE,
  parseLsTreeOutput,
  SYMLINK_MODE,
} from '../skills/git-tree.ts';
import { failureDetail } from '../skills/process.ts';
import { escapingLinks } from '../skills/tree.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Rejects refs git would read as an option, and other malformed refs. */
export function assertSafeGitRef(ref: string): void {
  if (
    ref.trim() === '' ||
    ref.startsWith('-') ||
    ref.includes('\0') ||
    /[\r\n]/.test(ref)
  ) {
    throw new EvalError(
      `Invalid git ref "${ref}": refs must be non-empty and cannot start with "-"`,
    );
  }
}

export interface GitOutputParams {
  cwd: string;
  args: readonly string[];
  env?: Environment;
  failure: string;
}

export async function gitOutput({
  cwd,
  args,
  env,
  failure,
}: GitOutputParams): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      env: gitEnvironment(env),
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    throw new EvalError(`${failure}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}

interface SkillPathParams {
  repoRoot: string;
  skillDir: string;
}

// Both sides are resolved so a skill reached through a symlinked folder (or
// macOS /var -> /private/var) still maps onto the repository tree.
export async function skillPathInRepository({
  repoRoot,
  skillDir,
}: SkillPathParams): Promise<string> {
  let realRoot: string;
  let realSkill: string;
  try {
    realRoot = await realpath(repoRoot);
    realSkill = await realpath(skillDir);
  } catch (error) {
    throw new EvalError(
      `Cannot resolve skill directory "${skillDir}" in repository "${repoRoot}"`,
      { cause: error },
    );
  }
  const relSkillDir = relative(realRoot, realSkill)
    .split(sep)
    .join('/')
    .replace(/\/+$/, '');
  if (
    !relSkillDir ||
    relSkillDir === '..' ||
    relSkillDir.startsWith('../') ||
    isAbsolute(relSkillDir)
  ) {
    throw new EvalError(
      `Skill directory "${skillDir}" is not inside a subfolder of repository "${repoRoot}"`,
    );
  }
  return relSkillDir;
}

export interface TreeEntry {
  mode: string;
  objectHash: string;
  relPath: string;
}

interface ParseTreeEntriesParams {
  output: string;
  prefix: string;
}

function isSafeTreePath(relPath: string): boolean {
  return (
    relPath !== '' &&
    !isAbsolute(relPath) &&
    relPath
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

// `ls-tree -z` output: `<mode> SP <type> SP <object> TAB <path>` records
// separated by NUL, with paths left unquoted.
export function parseTreeEntries({
  output,
  prefix,
}: ParseTreeEntriesParams): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of parseLsTreeOutput(output)) {
    if (!record.path.startsWith(prefix)) continue;
    const relPath = record.path.slice(prefix.length);
    if (!isSafeTreePath(relPath)) {
      throw new EvalError(`Refusing to extract unsafe path "${record.path}"`);
    }
    entries.push({
      mode: record.mode,
      objectHash: record.objectHash,
      relPath,
    });
  }
  return entries;
}

interface ReadBlobParams {
  repoRoot: string;
  entry: TreeEntry;
  ref: string;
  env?: Environment;
}

export async function readBlob({
  repoRoot,
  entry,
  ref,
  env,
}: ReadBlobParams): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['cat-file', 'blob', entry.objectHash],
      {
        cwd: repoRoot,
        env: gitEnvironment(env),
        encoding: 'buffer',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    return stdout;
  } catch (error) {
    throw new EvalError(
      `Failed to read "${entry.relPath}" at ref "${ref}": ${failureDetail(error)}`,
      { cause: error },
    );
  }
}

export interface ExtractSkillAtRefParams {
  repoRoot: string;
  skillDir: string;
  ref: string;
  destDir: string;
  env?: Environment;
}

/**
 * Materializes the skill tree at `ref` from `repoRoot` into `destDir` using
 * `git ls-tree -z` and `git cat-file blob` without modifying the working tree.
 * Writes regular files before symlinks and throws an `EvalError` if any
 * symlink resolves outside `destDir`.
 */
export async function extractSkillAtRef({
  repoRoot,
  skillDir,
  ref,
  destDir,
  env,
}: ExtractSkillAtRefParams): Promise<void> {
  assertSafeGitRef(ref);
  const relSkillDir = await skillPathInRepository({ repoRoot, skillDir });
  const prefix = `${relSkillDir}/`;
  const treeOutput = await gitOutput({
    cwd: repoRoot,
    args: [
      '--literal-pathspecs',
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      ref,
      '--',
      prefix,
    ],
    env,
    failure: `Failed to read skill "${relSkillDir}" at ref "${ref}"`,
  });
  const entries = parseTreeEntries({ output: treeOutput, prefix });
  if (entries.length === 0) {
    throw new EvalError(`Skill "${relSkillDir}" was not found at ref "${ref}"`);
  }

  await mkdir(destDir, { recursive: true });
  // Regular files first, links last, so no write ever goes through a link.
  const links: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.mode === SYMLINK_MODE) {
      links.push(entry);
      continue;
    }
    const outPath = join(destDir, ...entry.relPath.split('/'));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, await readBlob({ repoRoot, entry, ref, env }));
    if (entry.mode === EXECUTABLE_MODE) {
      await chmod(outPath, 0o755);
    }
  }
  for (const entry of links) {
    const target = (await readBlob({ repoRoot, entry, ref, env })).toString(
      'utf8',
    );
    if (!target || isAbsolute(target) || target.includes('\0')) {
      throw new EvalError(
        `Skill "${relSkillDir}" at ref "${ref}" has a link "${entry.relPath}" that points outside the skill (${target})`,
      );
    }
    const outPath = join(destDir, ...entry.relPath.split('/'));
    await mkdir(dirname(outPath), { recursive: true });
    await symlink(target, outPath);
  }
  const escaping = await escapingLinks(destDir);
  if (escaping.length > 0) {
    const detail = escaping
      .map((link) => `${link.path} -> ${link.target}`)
      .join(', ');
    throw new EvalError(
      `Skill "${relSkillDir}" at ref "${ref}" has links that point outside the skill: ${detail}`,
    );
  }
}

export interface ResolveSkillRepositoryParams {
  skillDir: string;
  env?: Environment;
}

/** The root of the git repository that contains the skill directory. */
export async function resolveSkillRepository({
  skillDir,
  env,
}: ResolveSkillRepositoryParams): Promise<string> {
  const output = await gitOutput({
    cwd: skillDir,
    args: ['rev-parse', '--show-toplevel'],
    env,
    failure: `Skill directory "${skillDir}" is not inside a git repository`,
  });
  const repoRoot = output.trim();
  if (!repoRoot) {
    throw new EvalError(
      `Skill directory "${skillDir}" is not inside a git work tree`,
    );
  }
  return repoRoot;
}

export interface VerifySkillAtRefParams {
  repoRoot: string;
  skillDir: string;
  ref: string;
  env?: Environment;
}

/** Fails early when the ref is not a commit or the skill is absent at it. */
export async function verifySkillAtRef({
  repoRoot,
  skillDir,
  ref,
  env,
}: VerifySkillAtRefParams): Promise<void> {
  assertSafeGitRef(ref);
  const relSkillDir = await skillPathInRepository({ repoRoot, skillDir });
  await gitOutput({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    env,
    failure: `"${ref}" was not found as a skill in skills/, catalog.yaml, or on disk, and git ref "${ref}" does not name a commit in ${repoRoot}`,
  });
  const type = await gitOutput({
    cwd: repoRoot,
    args: ['cat-file', '-t', `${ref}:${relSkillDir}`],
    env,
    failure: `Skill "${relSkillDir}" does not exist at ref "${ref}"`,
  });
  if (type.trim() !== 'tree') {
    throw new EvalError(
      `Skill "${relSkillDir}" at ref "${ref}" is not a directory`,
    );
  }
}
