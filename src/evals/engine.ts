import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
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
  type EvalVariant,
  prepareEvalWorkspace,
  resolveSkillRepository,
  validateEvalSuiteFileDestinations,
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

interface RunSingleEvalJobParams {
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
  env: Environment;
  onLog?: (line: string) => void;
  onContamination: (flags: {
    possiblyContaminated: boolean;
    skillShadowed: boolean;
    warning?: string;
  }) => void;
}

async function runSingleEvalJob({
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
  env,
  onLog,
  onContamination,
}: RunSingleEvalJobParams): Promise<EvalRunRecord> {
  const label = `[${job.evalCase.id}] ${job.variant} run ${job.runIndex}/${runs}`;
  const runDir = join(
    iterationDir,
    `eval-${job.evalCase.id}`,
    job.variant,
    `run-${job.runIndex}`,
  );
  await mkdir(runDir, { recursive: true });
  // A workspace that cannot be prepared is a harness problem shared by
  // every job, so it is fatal rather than a failed run.
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
    env,
  });

  onContamination({
    possiblyContaminated: prepared.possiblyContaminated,
    skillShadowed: Boolean(prepared.skillShadowed),
    warning: prepared.warning,
  });

  try {
    const startedAt = Date.now();
    let taskResult: RunnerTaskResult | undefined;
    let launchError: string | undefined;
    try {
      taskResult = await runner.runTask({
        prompt: job.evalCase.prompt,
        workdir: prepared.workdir,
        runDir,
        skillName,
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
            workdir: prepared.workdir,
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
  } finally {
    if (!keepWorkdirs) {
      await removeWorkdir({ path: prepared.workdir, onLog });
    }
  }
}

/**
 * Runs a skill evaluation suite across the selected cases and variants
 * (`with_skill`, optional `without_skill` baseline, and optional `old_skill`
 * at `compareRef`), grades each run, and writes `benchmark.json` and
 * `report.md` into a newly allocated `iteration-<N>` directory.
 *
 * Performs runner preflight and git ref verification before allocating the
 * iteration directory so invalid configuration leaves no empty directory behind.
 */
export async function runSkillEval({
  skillName,
  skillDir,
  evalsRootDir,
  runner,
  runs = 1,
  baseline = true,
  compareRef,
  caseId,
  caseIds,
  parallel = 2,
  timeoutSeconds = 600,
  sandbox = false,
  keepWorkdirs = false,
  paths,
  env,
  onLog,
}: RunSkillEvalParams): Promise<RunSkillEvalResult> {
  const suite = await loadEvalSuite(skillDir);
  const requestedIds = [...(caseId ? [caseId] : []), ...(caseIds ?? [])];
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
  validateEvalSuiteFileDestinations({ cases: selectedCases, skillName });

  const variants: EvalVariant[] = ['with_skill'];
  if (baseline) variants.push('without_skill');
  if (compareRef) variants.push('old_skill');

  // Everything that can fail for every job is checked before the iteration
  // directory exists, so a bad ref or a missing CLI leaves nothing behind.
  await runner.preflight?.();
  let repoRoot: string | undefined;
  if (compareRef !== undefined) {
    assertSafeGitRef(compareRef);
    repoRoot = await resolveSkillRepository({ skillDir, env });
    await verifySkillAtRef({ repoRoot, skillDir, ref: compareRef, env });
  }

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
      runSingleEvalJob({
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
        env,
        onLog,
        onContamination(flags) {
          if (flags.possiblyContaminated) {
            possiblyContaminated = true;
          }
          if (flags.skillShadowed) {
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
    warnings: [...warnings],
  });
  const reportMarkdown = renderBenchmarkReport(benchmark);

  await writeFile(
    join(iterationDir, 'benchmark.json'),
    `${JSON.stringify(benchmark, null, 2)}\n`,
  );
  await writeFile(join(iterationDir, 'report.md'), reportMarkdown);

  return {
    iterationDir,
    benchmark,
    reportMarkdown,
  };
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

export async function regenerateSkillReport({
  evalsRootDir,
  skillName,
  iterationDir,
}: RegenerateSkillReportParams): Promise<RegenerateSkillReportResult> {
  let targetDir = iterationDir;
  if (!targetDir) {
    if (!skillName) {
      throw new EvalError(
        'Either skillName or iterationDir is required to regenerate a report',
      );
    }
    targetDir = await findLatestIterationDir({ evalsRootDir, skillName });
  }
  const benchmark = await loadBenchmarkFromIteration(targetDir);
  const reportMarkdown = renderBenchmarkReport(benchmark);
  await writeFile(join(targetDir, 'report.md'), reportMarkdown);
  return {
    iterationDir: targetDir,
    benchmark,
    reportMarkdown,
  };
}
