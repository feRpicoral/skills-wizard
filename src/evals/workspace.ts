import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { copySkillTree } from '../skills/tree-replace.ts';
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
import {
  type CaseFileDestinationsParams,
  type ComparedSkillSpec,
  copyCaseFiles,
  EVAL_RUNNER_NAMES,
  type EvalRunnerName,
  type EvalSuiteFileDestinationsParams,
  FIXTURE_SKILL_FILE,
  HARNESS_OWNED_DIRS,
  type MapCaseFileParams,
  mapCaseFileRelativePath,
  prepareComparedSkillSetups,
  projectSkillsDir,
  stagedSkillDir,
  type StagedSkillDirParams,
  validateCaseFileDestinations,
  validateComparedSkillSpecs,
  validateEvalSuiteFileDestinations,
} from './workspace-files.ts';

export {
  applyBaselineExclusion,
  type ApplyBaselineExclusionParams,
  assertSafeGitRef,
  type CaseFileDestinationsParams,
  type ClaudePluginSkillParams,
  type ComparedSkillSpec,
  EVAL_RUNNER_NAMES,
  type EvalRunnerName,
  type EvalSuiteFileDestinationsParams,
  extractSkillAtRef,
  type ExtractSkillAtRefParams,
  findClaudePluginSkill,
  FIXTURE_SKILL_FILE,
  gitOutput,
  type GitOutputParams,
  type GlobalSkillCheckParams,
  isSkillInstalledGlobally,
  type MapCaseFileParams,
  mapCaseFileRelativePath,
  parseTreeEntries,
  type PersonalSkillShadowParams,
  personalSkillShadowWarning,
  prepareComparedSkillSetups,
  projectSkillsDir,
  readBlob,
  resolveSkillRepository,
  type ResolveSkillRepositoryParams,
  skillPathInRepository,
  stagedSkillDir,
  type StagedSkillDirParams,
  type TreeEntry,
  validateCaseFileDestinations,
  validateComparedSkillSpecs,
  validateEvalSuiteFileDestinations,
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

export type CompareSkillVariant = `compare:${string}`;

export type EvalVariant =
  'with_skill' | 'without_skill' | 'old_skill' | CompareSkillVariant;

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
      variant,
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
      variant,
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
    variant,
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
