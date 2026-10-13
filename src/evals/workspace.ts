import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { type Environment, gitEnvironment, type Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { lstatIfExists } from '../install/fs.ts';
import { scanInstalledSkills } from '../skills/collisions.ts';
import { failureDetail } from '../skills/process.ts';
import { copySkillTree, escapingLinks } from '../skills/tree.ts';
import type { EvalCase } from './cases.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

export type EvalVariant = 'with_skill' | 'without_skill' | 'old_skill';

export type EvalRunnerName = 'agy' | 'claude' | 'codex' | 'gemini' | 'fake';

export interface PreparedWorkspace {
  workdir: string;
  variant: EvalVariant;
  runner: EvalRunnerName;
  skillName: string;
  possiblyContaminated: boolean;
  warning?: string;
}

export interface MapCaseFileParams {
  fileEntry: string;
  caseId: string;
}

export function mapCaseFileRelativePath({
  fileEntry,
  caseId,
}: MapCaseFileParams): string {
  const normalized = posix.normalize(fileEntry.trim().replaceAll('\\', '/'));
  const prefix = 'evals/files/';
  const afterPrefix = normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
  const casePrefix = `${caseId}/`;
  if (
    afterPrefix.startsWith(casePrefix) &&
    afterPrefix.length > casePrefix.length
  ) {
    return afterPrefix.slice(casePrefix.length);
  }
  return afterPrefix;
}

interface GitCommandParams {
  cwd: string;
  args: string[];
  env?: Environment;
  failure: string;
}

async function runGit({
  cwd,
  args,
  env,
  failure,
}: GitCommandParams): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitEnvironment(env),
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    throw new EvalError(`${failure}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}

interface CopyCaseFilesParams {
  skillDir: string;
  workdir: string;
  evalCase: EvalCase;
}

async function copyCaseFiles({
  skillDir,
  workdir,
  evalCase,
}: CopyCaseFilesParams): Promise<void> {
  for (const fileEntry of evalCase.files) {
    const srcPath = join(skillDir, fileEntry);
    const relDest = mapCaseFileRelativePath({
      fileEntry,
      caseId: evalCase.id,
    });
    const destPath = join(workdir, relDest);
    const info = await stat(srcPath);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    await chmod(destPath, info.mode & 0o777);
  }
}

interface InitWorkspaceGitParams {
  workdir: string;
  env?: Environment;
}

async function initWorkspaceGit({
  workdir,
  env,
}: InitWorkspaceGitParams): Promise<void> {
  await runGit({
    cwd: workdir,
    args: ['init'],
    env,
    failure: 'Failed to initialize eval workspace git repository',
  });
  const excludePath = join(workdir, '.git', 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(
    excludePath,
    ['.agents/', '.claude/', '.gemini/', '.codex/', ''].join('\n'),
  );
  await runGit({
    cwd: workdir,
    args: ['add', '-A'],
    env,
    failure: 'Failed to stage eval workspace fixture files',
  });
  await runGit({
    cwd: workdir,
    args: [
      '-c',
      'user.name=agents-config',
      '-c',
      'user.email=eval@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'chore: eval workspace fixture',
    ],
    env,
    failure: 'Failed to commit eval workspace fixture files',
  });
}

export interface ExtractSkillAtRefParams {
  repoRoot: string;
  skillDir: string;
  ref: string;
  destDir: string;
  env?: Environment;
}

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

interface ApplyBaselineExclusionParams {
  workdir: string;
  skillName: string;
  runner: EvalRunnerName;
  paths?: Paths;
}

interface GlobalSkillCheckParams {
  skillName: string;
  paths?: Paths;
}

async function isSkillInstalledGlobally({
  skillName,
  paths,
}: GlobalSkillCheckParams): Promise<boolean> {
  if (!paths) return false;
  const candidateDirs = [
    join(paths.skillsDir, skillName),
    join(paths.claudeHome, 'skills', skillName),
    join(paths.codexHome, 'skills', skillName),
    join(paths.geminiHome, 'skills', skillName),
    join(paths.geminiHome, 'config', 'skills', skillName),
    join(paths.geminiHome, 'antigravity-cli', 'skills', skillName),
    join(paths.copilotHome, 'skills', skillName),
  ];
  for (const dir of candidateDirs) {
    if ((await lstatIfExists(dir)) !== null) {
      return true;
    }
  }
  const scan = await scanInstalledSkills(paths, null);
  return scan.skills.some((skill) => skill.name === skillName);
}

export async function applyBaselineExclusion({
  workdir,
  skillName,
  runner,
  paths,
}: ApplyBaselineExclusionParams): Promise<{
  possiblyContaminated: boolean;
  warning?: string;
}> {
  if (runner === 'agy' || runner === 'fake') {
    const file = join(workdir, '.agents', 'skills.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ exclude: [skillName] }, null, 2)}\n`,
    );
    return { possiblyContaminated: false };
  }

  if (runner === 'claude') {
    const file = join(workdir, '.claude', 'settings.local.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        {
          skillOverrides: { [skillName]: 'off' },
          permissions: {
            deny: [`Skill(${skillName})`, `Skill(${skillName} *)`],
          },
        },
        null,
        2,
      )}\n`,
    );
    return { possiblyContaminated: false };
  }

  if (runner === 'gemini') {
    const file = join(workdir, '.gemini', 'settings.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ skills: { disabled: [skillName] } }, null, 2)}\n`,
    );
    return { possiblyContaminated: false };
  }

  const installedGlobally = await isSkillInstalledGlobally({
    skillName,
    paths,
  });
  if (installedGlobally) {
    return {
      possiblyContaminated: true,
      warning: `Runner "${runner}" has no documented workspace-level skill exclusion flag and "${skillName}" is installed globally; baseline is possibly contaminated.`,
    };
  }
  return { possiblyContaminated: false };
}

export interface PrepareEvalWorkspaceParams {
  runDir: string;
  skillDir: string;
  skillName: string;
  evalCase: EvalCase;
  variant: EvalVariant;
  runner: EvalRunnerName;
  paths?: Paths;
  repoRoot?: string;
  compareRef?: string;
  env?: Environment;
}

export async function prepareEvalWorkspace({
  runDir,
  skillDir,
  skillName,
  evalCase,
  variant,
  runner,
  paths,
  repoRoot,
  compareRef,
  env,
}: PrepareEvalWorkspaceParams): Promise<PreparedWorkspace> {
  const workdir = join(runDir, 'workdir');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });

  await copyCaseFiles({ skillDir, workdir, evalCase });
  await initWorkspaceGit({ workdir, env });

  if (variant === 'with_skill') {
    const destSkillDir = join(workdir, '.agents', 'skills', skillName);
    await copySkillTree({ source: skillDir, destination: destSkillDir });
    return {
      workdir,
      variant,
      runner,
      skillName,
      possiblyContaminated: false,
    };
  }

  if (variant === 'old_skill') {
    if (!repoRoot || !compareRef) {
      throw new EvalError(
        'old_skill workspace requires both repoRoot and compareRef',
      );
    }
    const snapshotDir = join(runDir, '.old-skill-snapshot');
    await rm(snapshotDir, { recursive: true, force: true });
    try {
      await extractSkillAtRef({
        repoRoot,
        skillDir,
        ref: compareRef,
        destDir: snapshotDir,
        env,
      });
      const destSkillDir = join(workdir, '.agents', 'skills', skillName);
      await copySkillTree({ source: snapshotDir, destination: destSkillDir });
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
    return {
      workdir,
      variant,
      runner,
      skillName,
      possiblyContaminated: false,
    };
  }

  const exclusion = await applyBaselineExclusion({
    workdir,
    skillName,
    runner,
    paths,
  });
  return {
    workdir,
    variant,
    runner,
    skillName,
    possiblyContaminated: exclusion.possiblyContaminated,
    ...(exclusion.warning ? { warning: exclusion.warning } : {}),
  };
}

export interface PrepareTriggerWorkspaceParams {
  runDir: string;
  skillDir: string;
  skillName: string;
  env?: Environment;
}

export async function prepareTriggerWorkspace({
  runDir,
  skillDir,
  skillName,
  env,
}: PrepareTriggerWorkspaceParams): Promise<string> {
  const workdir = join(runDir, 'workdir');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  await initWorkspaceGit({ workdir, env });
  const destSkillDir = join(workdir, '.agents', 'skills', skillName);
  await copySkillTree({ source: skillDir, destination: destSkillDir });
  return workdir;
}

const SYMLINK_MODE = '120000';
const EXECUTABLE_MODE = '100755';
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

interface GitOutputParams {
  cwd: string;
  args: string[];
  env?: Environment;
  failure: string;
}

async function gitOutput({
  cwd,
  args,
  env,
  failure,
}: GitOutputParams): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
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
async function skillPathInRepository({
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

interface TreeEntry {
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
function parseTreeEntries({
  output,
  prefix,
}: ParseTreeEntriesParams): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) continue;
    const [mode, type, objectHash] = record.slice(0, tabIndex).split(' ');
    const treePath = record.slice(tabIndex + 1);
    // Submodules (type "commit") have no content to extract.
    if (type !== 'blob' || !mode || !objectHash) continue;
    if (!treePath.startsWith(prefix)) continue;
    const relPath = treePath.slice(prefix.length);
    if (!isSafeTreePath(relPath)) {
      throw new EvalError(`Refusing to extract unsafe path "${treePath}"`);
    }
    entries.push({ mode, objectHash, relPath });
  }
  return entries;
}

interface ReadBlobParams {
  repoRoot: string;
  entry: TreeEntry;
  ref: string;
  env?: Environment;
}

async function readBlob({
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
    failure: `Git ref "${ref}" does not name a commit in ${repoRoot}`,
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
