import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative } from 'node:path';
import { promisify } from 'node:util';

import { type Environment, gitEnvironment, type Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { lstatIfExists } from '../install/fs.ts';
import { failureDetail } from '../skills/process.ts';
import { copySkillTree } from '../skills/tree.ts';
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
  const relSkillDir = relative(repoRoot, skillDir).replaceAll('\\', '/');
  if (!relSkillDir || relSkillDir.startsWith('..')) {
    throw new EvalError(
      `Skill directory "${skillDir}" is outside repository "${repoRoot}"`,
    );
  }
  const prefix = `${relSkillDir.replace(/\/+$/, '')}/`;
  const treeOutput = await runGit({
    cwd: repoRoot,
    args: ['ls-tree', '-r', '--full-tree', ref, '--', prefix],
    env,
    failure: `Failed to read skill "${relSkillDir}" at ref "${ref}"`,
  });
  const lines = treeOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new EvalError(`Skill "${relSkillDir}" was not found at ref "${ref}"`);
  }

  await mkdir(destDir, { recursive: true });
  for (const line of lines) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    const header = line.slice(0, tabIndex).trim().split(/\s+/);
    const mode = header[0];
    const type = header[1];
    const objectHash = header[2];
    const treePath = line.slice(tabIndex + 1);
    if (type !== 'blob' || !objectHash || !treePath.startsWith(prefix)) {
      continue;
    }
    const relPath = treePath.slice(prefix.length);
    const outPath = join(destDir, relPath);
    await mkdir(dirname(outPath), { recursive: true });
    const { stdout } = await execFileAsync('git', ['show', objectHash], {
      cwd: repoRoot,
      env: gitEnvironment(env),
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    await writeFile(outPath, stdout);
    if (mode === '100755') {
      await chmod(outPath, 0o755);
    }
  }
}

interface ApplyBaselineExclusionParams {
  workdir: string;
  skillName: string;
  runner: EvalRunnerName;
  paths?: Paths;
}

async function isSkillInstalledGlobally(
  skillName: string,
  paths?: Paths,
): Promise<boolean> {
  if (!paths) return false;
  const candidateDirs = [
    join(paths.skillsDir, skillName),
    join(paths.claudeHome, 'skills', skillName),
    join(paths.codexHome, 'skills', skillName),
    join(paths.geminiHome, 'skills', skillName),
    join(paths.copilotHome, 'skills', skillName),
  ];
  for (const dir of candidateDirs) {
    if ((await lstatIfExists(dir)) !== null) {
      return true;
    }
  }
  return false;
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

  const installedGlobally = await isSkillInstalledGlobally(skillName, paths);
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
