import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { escapingLinks } from '../skills/tree.ts';
import {
  aggregateBenchmark,
  type BenchmarkSummary,
  type EvalRunRecord,
  loadBenchmarkFromIteration,
} from './aggregate.ts';
import { type EvalCase, loadEvalSuite } from './cases.ts';
import { gradeEvalRun, recordFailedRun } from './grade.ts';
import {
  allocateIterationDir,
  type AllocateIterationDirParams,
  findLatestIterationDir,
  type FindLatestIterationDirParams,
  removeWorkdir,
} from './iterations.ts';
import { renderBenchmarkReport } from './report.ts';
import type { EvalRunner, RunnerTaskResult } from './runners/types.ts';
import {
  runSkillTriggers,
  type RunSkillTriggersParams,
  type RunSkillTriggersResult,
  runWithConcurrency,
} from './trigger-engine.ts';
import {
  assertSafeGitRef,
  type ComparedSkillSpec,
  compareSkillVariant,
  type EvalVariant,
  parseCompareSkillVariant,
  prepareComparedSkillSetups,
  prepareEvalWorkspace,
  resolveSkillRepository,
  validateComparedSkillSpecs,
  validateEvalSuiteFileDestinations,
  variantDirName,
  verifySkillAtRef,
} from './workspace.ts';

export {
  allocateIterationDir,
  type AllocateIterationDirParams,
  findLatestIterationDir,
  type FindLatestIterationDirParams,
  runSkillTriggers,
  type RunSkillTriggersParams,
  type RunSkillTriggersResult,
};

export interface RunSkillEvalParams {
  skillName: string;
  skillDir: string;
  evalsRootDir: string;
  runner: EvalRunner;
  runs?: number;
  baseline?: boolean;
  compareRef?: string;
  compareSkills?: readonly ComparedSkillSpec[];
  caseId?: string;
  caseIds?: readonly string[];
  parallel?: number;
  timeoutSeconds?: number;
  sandbox?: boolean;
  keepWorkdirs?: boolean;
  paths?: Paths;
  env: Environment;
  onLog?: (line: string) => void;
}

export interface RunSkillEvalResult {
  iterationDir: string;
  benchmark: BenchmarkSummary;
  reportMarkdown: string;
}

interface EvalJob {
  evalCase: EvalCase;
  variant: EvalVariant;
  runIndex: number;
}

async function runAndGradeTask(params: {
  job: EvalJob;
  workdir: string;
  runDir: string;
  activeSkillName: string;
  runner: EvalRunner;
  timeoutSeconds: number;
  sandbox: boolean;
  env: Environment;
  label: string;
  onLog?: (line: string) => void;
}): Promise<EvalRunRecord> {
  const {
    job,
    workdir,
    runDir,
    activeSkillName,
    runner,
    timeoutSeconds,
    sandbox,
    env,
    label,
    onLog,
  } = params;

  const startedAt = Date.now();
  let taskResult: RunnerTaskResult | undefined;
  let launchError: string | undefined;

  try {
    taskResult = await runner.runTask({
      prompt: job.evalCase.prompt,
      workdir,
      runDir,
      skillName: activeSkillName,
      timeoutSeconds,
      sandbox,
      excludeSkill: job.variant === 'without_skill',
    });
  } catch (error) {
    launchError = error instanceof Error ? error.message : String(error);
  }

  const { grading, timing } =
    taskResult === undefined
      ? await recordFailedRun({
          evalCase: job.evalCase,
          runDir,
          error: launchError ?? 'Runner failed',
          durationMs: Date.now() - startedAt,
        })
      : await gradeEvalRun({
          evalCase: job.evalCase,
          workdir,
          runDir,
          taskResult,
          runner,
          timeoutSeconds,
          env,
        });

  onLog?.(
    timing.error === undefined
      ? `${label}: ${grading.summary.passed}/${grading.summary.total} passed (${timing.total_duration_seconds.toFixed(1)}s)`
      : `${label}: agent run failed: ${timing.error}`,
  );

  return {
    case_id: job.evalCase.id,
    prompt: job.evalCase.prompt,
    variant: job.variant,
    run_index: job.runIndex,
    grading,
    timing,
  };
}

interface ExecuteEvalJobParams {
  job: EvalJob;
  iterationDir: string;
  skillDir: string;
  skillName: string;
  runner: EvalRunner;
  runs: number;
  timeoutSeconds: number;
  sandbox: boolean;
  keepWorkdirs: boolean;
  paths?: Paths;
  repoRoot?: string;
  compareRef?: string;
  compareSkillsByName: ReadonlyMap<string, ComparedSkillSpec>;
  env: Environment;
  onLog?: (line: string) => void;
  onContamination: (flags: {
    variant: EvalVariant;
    possiblyContaminated: boolean;
    skillShadowed: boolean;
    warning?: string;
  }) => void;
}

async function executeEvalJob(
  params: ExecuteEvalJobParams,
): Promise<EvalRunRecord> {
  const {
    job,
    iterationDir,
    skillDir,
    skillName,
    runner,
    runs,
    timeoutSeconds,
    sandbox,
    keepWorkdirs,
    paths,
    repoRoot,
    compareRef,
    compareSkillsByName,
    env,
    onLog,
    onContamination,
  } = params;

  const label = `[${job.evalCase.id}] ${job.variant} run ${job.runIndex}/${runs}`;
  const runDir = join(
    iterationDir,
    `eval-${job.evalCase.id}`,
    variantDirName(job.variant),
    `run-${job.runIndex}`,
  );
  await mkdir(runDir, { recursive: true });

  const comparedName = parseCompareSkillVariant(job.variant);
  const compareSkill =
    comparedName !== undefined
      ? compareSkillsByName.get(comparedName)
      : undefined;
  const activeSkillName = compareSkill?.skillName ?? skillName;
  const prepared = await prepareEvalWorkspace({
    runDir,
    skillDir,
    skillName,
    evalCase: job.evalCase,
    variant: job.variant,
    runner: runner.name,
    paths,
    repoRoot,
    compareRef,
    compareSkill,
    compareSkills: [...compareSkillsByName.values()],
    env,
  });

  onContamination({
    variant: job.variant,
    possiblyContaminated: prepared.possiblyContaminated,
    skillShadowed: Boolean(prepared.skillShadowed),
    warning: prepared.warning,
  });

  try {
    return await runAndGradeTask({
      job,
      workdir: prepared.workdir,
      runDir,
      activeSkillName,
      runner,
      timeoutSeconds,
      sandbox,
      env,
      label,
      onLog,
    });
  } finally {
    if (!keepWorkdirs) {
      await removeWorkdir({ path: prepared.workdir, onLog });
    }
  }
}

async function prepareEvalSuiteContext(params: RunSkillEvalParams): Promise<{
  selectedCases: EvalCase[];
  compareSkillsByName: Map<string, ComparedSkillSpec>;
  compareSkillNames: string[];
  variants: EvalVariant[];
  repoRoot: string | undefined;
}> {
  const {
    skillName,
    skillDir,
    runner,
    baseline = true,
    compareRef,
    compareSkills,
    caseId,
    caseIds,
    env,
  } = params;

  if (compareRef !== undefined && (compareSkills?.length ?? 0) > 0) {
    throw new EvalError(
      'Cannot combine compareRef and compareSkills in the same evaluation',
    );
  }

  const suite = await loadEvalSuite(skillDir);
  const singleId = caseId ? [caseId] : [];
  const requestedIds = [...singleId, ...(caseIds ?? [])];

  for (const id of requestedIds) {
    if (!suite.evals.some((item) => item.id === id)) {
      throw new EvalError(`Eval case "${id}" was not found in ${skillName}`);
    }
  }

  const selectedCases =
    requestedIds.length > 0
      ? suite.evals.filter((item) => requestedIds.includes(item.id))
      : suite.evals;

  if (selectedCases.length === 0) {
    throw new EvalError(`No eval cases found in ${skillName}`);
  }

  const primaryEscaping = await escapingLinks(skillDir);

  if (primaryEscaping.length > 0) {
    throw new EvalError(
      `Skill "${skillName}" has links that point outside the skill folder: ${primaryEscaping.map((link) => `${link.path} -> ${link.target}`).join(', ')}`,
    );
  }

  const compareSkillsByName = await validateComparedSkillSpecs(
    skillName,
    compareSkills,
  );
  const compareSkillNames = [...compareSkillsByName.keys()];

  validateEvalSuiteFileDestinations({
    cases: selectedCases,
    skillName,
    compareSkillNames,
  });

  const variants: EvalVariant[] = ['with_skill'];
  if (baseline) variants.push('without_skill');
  if (compareRef) variants.push('old_skill');

  for (const name of compareSkillNames) {
    variants.push(compareSkillVariant(name));
  }

  await runner.preflight?.();

  let repoRoot: string | undefined;

  if (compareRef !== undefined) {
    assertSafeGitRef(compareRef);
    repoRoot = await resolveSkillRepository({ skillDir, env });
    await verifySkillAtRef({ repoRoot, skillDir, ref: compareRef, env });
  }

  return {
    selectedCases,
    compareSkillsByName,
    compareSkillNames,
    variants,
    repoRoot,
  };
}

/**
 * Runs a skill evaluation suite across the selected cases and variants
 * (`with_skill`, optional `without_skill` baseline, optional `old_skill`
 * at `compareRef`, and optional competing `compareSkills`), grades each run,
 * and writes `benchmark.json` and `report.md` into a newly allocated
 * `iteration-<N>` directory.
 *
 * Performs runner preflight and git ref verification before allocating the
 * iteration directory so invalid configuration leaves no empty directory behind.
 */
export async function runSkillEval(
  params: RunSkillEvalParams,
): Promise<RunSkillEvalResult> {
  const {
    skillName,
    skillDir,
    evalsRootDir,
    runner,
    runs = 1,
    baseline = true,
    compareRef,
    parallel = 2,
    timeoutSeconds = 600,
    sandbox = false,
    keepWorkdirs = false,
    paths,
    env,
    onLog,
  } = params;
  const {
    selectedCases,
    compareSkillsByName,
    compareSkillNames,
    variants,
    repoRoot,
  } = await prepareEvalSuiteContext(params);

  const tempDirs: string[] = [];

  try {
    await prepareComparedSkillSetups(compareSkillsByName, tempDirs);

    const iterationDir = await allocateIterationDir({
      evalsRootDir,
      skillName,
    });

    const jobs: EvalJob[] = [];

    for (const evalCase of selectedCases) {
      for (const variant of variants) {
        for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
          jobs.push({ evalCase, variant, runIndex });
        }
      }
    }

    const warnings = new Set<string>();
    let possiblyContaminated = false;
    let withSkillContaminated = false;

    const records = await runWithConcurrency({
      items: jobs,
      concurrency: parallel,
      worker: (job) =>
        executeEvalJob({
          job,
          iterationDir,
          skillDir,
          skillName,
          runner,
          runs,
          timeoutSeconds,
          sandbox,
          keepWorkdirs,
          paths,
          repoRoot,
          compareRef,
          compareSkillsByName,
          env,
          onLog,
          onContamination(flags) {
            if (
              flags.variant === 'without_skill' &&
              flags.possiblyContaminated
            ) {
              possiblyContaminated = true;
            }

            if (
              (flags.variant === 'with_skill' ||
                flags.variant === 'old_skill') &&
              (flags.possiblyContaminated || flags.skillShadowed)
            ) {
              withSkillContaminated = true;
            }

            if (flags.warning && !warnings.has(flags.warning)) {
              warnings.add(flags.warning);
              onLog?.(`warning: ${flags.warning}`);
            }
          },
        }),
    });

    const benchmark = aggregateBenchmark({
      skillName,
      skillPath: skillDir,
      runner: runner.name,
      runsPerConfig: runs,
      cases: selectedCases,
      runs: records,
      baselineEnabled: baseline,
      possiblyContaminated,
      withSkillContaminated,
      compareRef,
      compareSkills: compareSkillNames,
      warnings: [...warnings],
    });
    const reportMarkdown = renderBenchmarkReport(benchmark);

    await writeFile(
      join(iterationDir, 'benchmark.json'),
      `${JSON.stringify(benchmark, null, 2)}\n`,
    );
    await writeFile(join(iterationDir, 'report.md'), reportMarkdown);

    return { iterationDir, benchmark, reportMarkdown };
  } finally {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
}

export interface RegenerateSkillReportParams {
  evalsRootDir: string;
  skillName?: string;
  iterationDir?: string;
}

export interface RegenerateSkillReportResult {
  iterationDir: string;
  benchmark: BenchmarkSummary;
  reportMarkdown: string;
}

async function resolveReportIterationDir({
  evalsRootDir,
  skillName,
  iterationDir,
}: RegenerateSkillReportParams): Promise<string> {
  if (iterationDir !== undefined) return iterationDir;
  if (skillName) return findLatestIterationDir({ evalsRootDir, skillName });

  throw new EvalError(
    'Either skillName or iterationDir is required to regenerate a report',
  );
}

export async function regenerateSkillReport({
  evalsRootDir,
  skillName,
  iterationDir,
}: RegenerateSkillReportParams): Promise<RegenerateSkillReportResult> {
  const targetDir = await resolveReportIterationDir({
    evalsRootDir,
    skillName,
    iterationDir,
  });
  const benchmark = await loadBenchmarkFromIteration(targetDir);
  const reportMarkdown = renderBenchmarkReport(benchmark);

  await writeFile(join(targetDir, 'report.md'), reportMarkdown);

  return { iterationDir: targetDir, benchmark, reportMarkdown };
}
