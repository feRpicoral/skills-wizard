import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { copySkillTree } from '../skills/tree.ts';
import { type ToolId, TOOLS } from '../tools/registry.ts';
import type { EvalCase } from './cases.ts';
import {
  applyBaselineExclusion,
  type ApplyBaselineExclusionParams,
  type ClaudePluginSkillParams,
  findClaudePluginSkill,
  type GlobalSkillCheckParams,
  isSkillInstalledGlobally,
  type PersonalSkillShadowParams,
  personalSkillShadowWarning,
} from './contamination.ts';
import {
  assertSafeGitRef,
  extractSkillAtRef,
  type ExtractSkillAtRefParams,
  gitOutput,
  type GitOutputParams,
  parseTreeEntries,
  readBlob,
  resolveSkillRepository,
  type ResolveSkillRepositoryParams,
  skillPathInRepository,
  type TreeEntry,
  verifySkillAtRef,
  type VerifySkillAtRefParams,
} from './git-snapshot.ts';

export {
  applyBaselineExclusion,
  type ApplyBaselineExclusionParams,
  assertSafeGitRef,
  type ClaudePluginSkillParams,
  extractSkillAtRef,
  type ExtractSkillAtRefParams,
  findClaudePluginSkill,
  gitOutput,
  type GitOutputParams,
  type GlobalSkillCheckParams,
  isSkillInstalledGlobally,
  parseTreeEntries,
  type PersonalSkillShadowParams,
  personalSkillShadowWarning,
  readBlob,
  resolveSkillRepository,
  type ResolveSkillRepositoryParams,
  skillPathInRepository,
  type TreeEntry,
  verifySkillAtRef,
  type VerifySkillAtRefParams,
};

/**
 * Config passed to every git command run in an eval workspace, so that hooks
 * and fsmonitor commands from the user's global git config never run.
 */
const WORKSPACE_GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
] as const;

/** Directories the harness or the agent CLIs own inside an eval workspace. */
const HARNESS_OWNED_DIRS = ['.agents', '.claude', '.gemini', '.codex'] as const;

const DEFAULT_PROJECT_SKILLS_DIR = posix.join('.agents', 'skills');

/** Fixture file name that is staged into eval workspaces as `SKILL.md`. */
export const FIXTURE_SKILL_FILE = 'SKILL.fixture.md';

export type CompareSkillVariant = `compare:${string}`;

export type EvalVariant =
  'with_skill' | 'without_skill' | 'old_skill' | CompareSkillVariant;

export interface ComparedSkillSpec {
  skillName: string;
  skillDir: string;
  setup?: string;
}

export function compareSkillVariant(skillName: string): CompareSkillVariant {
  return `compare:${skillName}`;
}

export function parseCompareSkillVariant(
  variant: EvalVariant,
): string | undefined {
  return variant.startsWith('compare:')
    ? variant.slice('compare:'.length)
    : undefined;
}

export function variantDirName(variant: EvalVariant): string {
  const compared = parseCompareSkillVariant(variant);
  return compared !== undefined ? `compare-${compared}` : variant;
}

export const EVAL_RUNNER_NAMES = [
  'agy',
  'claude',
  'codex',
  'gemini',
  'fake',
] as const;

export type EvalRunnerName = (typeof EVAL_RUNNER_NAMES)[number];

const RUNNER_TOOLS: Readonly<Record<EvalRunnerName, ToolId | null>> = {
  agy: 'antigravity-cli',
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini-cli',
  fake: null,
};

/**
 * The project skills folder the runner's CLI reads, relative to the workspace
 * (`.claude/skills` for Claude Code, `.agents/skills` for every other runner).
 */
export function projectSkillsDir(runner: EvalRunnerName): string {
  const tool = RUNNER_TOOLS[runner];
  const folder = tool ? TOOLS[tool].project.skills : undefined;
  return folder ? folder.replaceAll('\\', '/') : DEFAULT_PROJECT_SKILLS_DIR;
}

export interface StagedSkillDirParams {
  workdir: string;
  runner: EvalRunnerName;
  skillName: string;
}

/** Where the skill under evaluation is staged in a workspace for a runner. */
export function stagedSkillDir({
  workdir,
  runner,
  skillName,
}: StagedSkillDirParams): string {
  return join(workdir, projectSkillsDir(runner), skillName);
}

export interface PreparedWorkspace {
  workdir: string;
  variant: EvalVariant;
  runner: EvalRunnerName;
  skillName: string;
  /**
   * True when workspace-level skill exclusions could not cover a globally
   * installed or plugin skill.
   */
  possiblyContaminated: boolean;
  /**
   * True when a personal Claude skill shadows the staged skill in this
   * workspace.
   */
  skillShadowed: boolean;
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
  const relative =
    afterPrefix.startsWith(casePrefix) && afterPrefix.length > casePrefix.length
      ? afterPrefix.slice(casePrefix.length)
      : afterPrefix;
  // Fixture skills are stored as SKILL.fixture.md so that tools scanning a
  // linked skill folder never discover them; they are staged as SKILL.md.
  if (posix.basename(relative) === FIXTURE_SKILL_FILE) {
    return posix.join(posix.dirname(relative), 'SKILL.md');
  }
  return relative;
}

export interface CaseFileDestinationsParams {
  evalCase: Pick<EvalCase, 'id' | 'files'>;
  skillName: string;
  compareSkillNames?: readonly string[];
}

function isUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Checks where a case's fixture files land in the workspace before anything
 * is copied: destinations must stay inside the workspace, must not be inside
 * `.git/`, the staged skill folder or a directory the harness and agent CLIs
 * own (`.agents/`, `.claude/`, `.gemini/`, `.codex/`), and must not collide
 * with each other. Comparisons ignore case, as on case-insensitive file
 * systems. Throws an `EvalError` describing every problem.
 */
export function validateCaseFileDestinations({
  evalCase,
  skillName,
  compareSkillNames = [],
}: CaseFileDestinationsParams): void {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const allSkillNames = [skillName, ...compareSkillNames];
  const stagedDirs = new Set(
    EVAL_RUNNER_NAMES.flatMap((runner) =>
      allSkillNames.map((name) =>
        posix.join(projectSkillsDir(runner), name).toLowerCase(),
      ),
    ),
  );

  for (const fileEntry of evalCase.files) {
    const dest = mapCaseFileRelativePath({ fileEntry, caseId: evalCase.id });
    const folded = dest.toLowerCase();
    if (
      dest === '' ||
      dest === '.' ||
      posix.isAbsolute(dest) ||
      dest === '..' ||
      dest.startsWith('../')
    ) {
      problems.push(`"${fileEntry}" maps outside the workspace ("${dest}")`);
      continue;
    }
    if (isUnderDir(folded, '.git')) {
      problems.push(`"${fileEntry}" maps into ".git/" ("${dest}")`);
      continue;
    }
    const stagedDir = [...stagedDirs].find((dir) => isUnderDir(folded, dir));
    if (stagedDir) {
      problems.push(
        `"${fileEntry}" maps into the staged skill folder "${stagedDir}/" ("${dest}")`,
      );
      continue;
    }
    const ownedDir = HARNESS_OWNED_DIRS.find((dir) => isUnderDir(folded, dir));
    if (ownedDir) {
      problems.push(
        `"${fileEntry}" maps into "${ownedDir}/", which the eval harness and agent CLIs own ("${dest}")`,
      );
      continue;
    }
    const previous = seen.get(folded);
    if (previous !== undefined) {
      problems.push(
        `"${fileEntry}" and "${previous}" map to the same destination "${dest}"`,
      );
      continue;
    }
    seen.set(folded, fileEntry);
  }

  for (const [folded, fileEntry] of seen) {
    for (const [other, otherEntry] of seen) {
      if (other !== folded && other.startsWith(`${folded}/`)) {
        problems.push(
          `"${fileEntry}" maps to a file that "${otherEntry}" needs as a directory`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new EvalError(
      `Eval case "${evalCase.id}" has invalid fixture files: ${problems.join('; ')}`,
    );
  }
}

export interface EvalSuiteFileDestinationsParams {
  cases: readonly Pick<EvalCase, 'id' | 'files'>[];
  skillName: string;
  compareSkillNames?: readonly string[];
}

/**
 * Runs `validateCaseFileDestinations` for every case, so an eval can fail
 * before any job starts.
 */
export function validateEvalSuiteFileDestinations({
  cases,
  skillName,
  compareSkillNames,
}: EvalSuiteFileDestinationsParams): void {
  for (const evalCase of cases) {
    validateCaseFileDestinations({ evalCase, skillName, compareSkillNames });
  }
}

interface CopyCaseFilesParams {
  skillDir: string;
  skillName: string;
  compareSkillNames?: readonly string[];
  workdir: string;
  evalCase: EvalCase;
}

async function copyCaseFiles({
  skillDir,
  skillName,
  compareSkillNames,
  workdir,
  evalCase,
}: CopyCaseFilesParams): Promise<void> {
  validateCaseFileDestinations({ evalCase, skillName, compareSkillNames });
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
  await gitOutput({
    cwd: workdir,
    args: [...WORKSPACE_GIT_CONFIG, 'init'],
    env,
    failure: 'Failed to initialize eval workspace git repository',
  });
  const excludePath = join(workdir, '.git', 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(
    excludePath,
    [...HARNESS_OWNED_DIRS.map((dir) => `${dir}/`), ''].join('\n'),
  );
  await gitOutput({
    cwd: workdir,
    args: [...WORKSPACE_GIT_CONFIG, 'add', '-A'],
    env,
    failure: 'Failed to stage eval workspace fixture files',
  });
  await gitOutput({
    cwd: workdir,
    args: [
      ...WORKSPACE_GIT_CONFIG,
      '-c',
      'user.name=agents-config',
      '-c',
      'user.email=eval@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '--allow-empty',
      '-m',
      'chore: eval workspace fixture',
    ],
    env,
    failure: 'Failed to commit eval workspace fixture files',
  });
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
  compareSkill?: ComparedSkillSpec;
  compareSkills?: readonly ComparedSkillSpec[];
  env?: Environment;
}

/**
 * Creates `<runDir>/workdir`, copies case fixture files, initializes a clean
 * git repository with harness-owned directories excluded, and either stages
 * the target skill (`with_skill` / `old_skill` / `compare:<name>`) or applies
 * workspace-level baseline exclusions (`without_skill`).
 */
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
  compareSkill,
  compareSkills,
  env,
}: PrepareEvalWorkspaceParams): Promise<PreparedWorkspace> {
  const workdir = join(runDir, 'workdir');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });

  const allCompareNames = [
    ...new Set([
      ...(compareSkills?.map((item) => item.skillName) ?? []),
      ...(compareSkill ? [compareSkill.skillName] : []),
    ]),
  ];

  await copyCaseFiles({
    skillDir,
    skillName,
    ...(allCompareNames.length > 0
      ? { compareSkillNames: allCompareNames }
      : {}),
    workdir,
    evalCase,
  });
  await initWorkspaceGit({ workdir, env });

  if (variant === 'with_skill' || variant === 'old_skill') {
    const destSkillDir = stagedSkillDir({ workdir, runner, skillName });
    if (variant === 'with_skill') {
      await copySkillTree({ source: skillDir, destination: destSkillDir });
    } else {
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
        await copySkillTree({ source: snapshotDir, destination: destSkillDir });
      } finally {
        await rm(snapshotDir, { recursive: true, force: true });
      }
    }
    const exclusion = await applyBaselineExclusion({
      workdir,
      skillNames: allCompareNames,
      runner,
      paths,
    });
    const shadowWarning = await personalSkillShadowWarning({
      runner,
      skillName,
      paths,
    });
    const combinedWarning = [exclusion.warning, shadowWarning]
      .filter((item): item is string => item !== undefined)
      .join(' ');
    return {
      workdir,
      variant,
      runner,
      skillName,
      possiblyContaminated: exclusion.possiblyContaminated,
      skillShadowed: shadowWarning !== undefined,
      ...(combinedWarning ? { warning: combinedWarning } : {}),
    };
  }

  if (parseCompareSkillVariant(variant) !== undefined) {
    if (!compareSkill) {
      throw new EvalError(`${variant} workspace requires compareSkill`);
    }
    const destSkillDir = stagedSkillDir({
      workdir,
      runner,
      skillName: compareSkill.skillName,
    });
    await copySkillTree({
      source: compareSkill.skillDir,
      destination: destSkillDir,
    });
    const otherCompareNames = allCompareNames.filter(
      (name) => name !== compareSkill.skillName,
    );
    const exclusion = await applyBaselineExclusion({
      workdir,
      skillNames: [skillName, ...otherCompareNames],
      runner,
      paths,
    });
    const shadowWarning = await personalSkillShadowWarning({
      runner,
      skillName: compareSkill.skillName,
      paths,
    });
    const combinedWarning = [exclusion.warning, shadowWarning]
      .filter((item): item is string => item !== undefined)
      .join(' ');
    return {
      workdir,
      variant,
      runner,
      skillName: compareSkill.skillName,
      possiblyContaminated: exclusion.possiblyContaminated,
      skillShadowed: shadowWarning !== undefined,
      ...(combinedWarning ? { warning: combinedWarning } : {}),
    };
  }

  const exclusion = await applyBaselineExclusion({
    workdir,
    skillNames: [skillName, ...allCompareNames],
    runner,
    paths,
  });
  return {
    workdir,
    variant,
    runner,
    skillName,
    possiblyContaminated: exclusion.possiblyContaminated,
    skillShadowed: false,
    ...(exclusion.warning ? { warning: exclusion.warning } : {}),
  };
}

export interface PrepareTriggerWorkspaceParams {
  runDir: string;
  skillDir: string;
  skillName: string;
  runner: EvalRunnerName;
  env?: Environment;
}

/**
 * Prepares a trigger-eval workspace with the skill staged where the runner
 * reads project skills. Call `personalSkillShadowWarning` once per trigger
 * eval to report a personal skill that would be loaded instead.
 */
export async function prepareTriggerWorkspace({
  runDir,
  skillDir,
  skillName,
  runner,
  env,
}: PrepareTriggerWorkspaceParams): Promise<string> {
  const workdir = join(runDir, 'workdir');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  await initWorkspaceGit({ workdir, env });
  const destSkillDir = stagedSkillDir({ workdir, runner, skillName });
  await copySkillTree({ source: skillDir, destination: destSkillDir });
  return workdir;
}
