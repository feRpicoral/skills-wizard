import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { isDirectory, statIfExists } from '../install/fs.ts';
import {
  aggregateBenchmark,
  aggregateTriggerRuns,
  type BenchmarkSummary,
  type EvalRunRecord,
  loadBenchmarkFromIteration,
  type TriggerBenchmarkSummary,
  type TriggerQueryRunResult,
} from './aggregate.ts';
import {
  type EvalCase,
  loadEvalSuite,
  loadTriggerQueries,
  selectTriggerQueries,
  splitTriggerQueries,
  type TriggerSplit,
} from './cases.ts';
import { gradeEvalRun, recordFailedRun, runFailure } from './grade.ts';
import { renderBenchmarkReport, renderTriggerReport } from './report.ts';
import type { EvalRunner, RunnerTaskResult } from './runners/types.ts';
import {
  assertSafeGitRef,
  type EvalVariant,
  personalSkillShadowWarning,
  prepareEvalWorkspace,
  prepareTriggerWorkspace,
  resolveSkillRepository,
  validateEvalSuiteFileDestinations,
  verifySkillAtRef,
} from './workspace.ts';

interface BoundedConcurrencyParams<T, R> {
  items: readonly T[];
  concurrency: number;
  worker: (item: T, index: number) => Promise<R>;
}

// Workers catch their own per-job failures, so an error reaching this loop is
// fatal: no new jobs start, the running ones finish, then the error is thrown.
async function runWithConcurrency<T, R>({
  items,
  concurrency,
  worker,
}: BoundedConcurrencyParams<T, R>): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let fatal: { error: unknown } | undefined;

  async function next(): Promise<void> {
    while (fatal === undefined && nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current];
      if (item === undefined) continue;
      try {
        results[current] = await worker(item, current);
      } catch (error) {
        fatal ??= { error };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    next(),
  );
  await Promise.all(workers);
  if (fatal !== undefined) throw fatal.error;
  return results;
}

const MAX_ITERATION_ATTEMPTS = 1000;

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export interface AllocateIterationDirParams {
  evalsRootDir: string;
  skillName: string;
  prefix?: string;
}

// The final mkdir is not recursive, so two evals started together never share
// a directory: the loser gets EEXIST and moves on to the next number.
export async function allocateIterationDir({
  evalsRootDir,
  skillName,
  prefix = 'iteration',
}: AllocateIterationDirParams): Promise<string> {
  const skillEvalsDir = join(evalsRootDir, skillName);
  await mkdir(skillEvalsDir, { recursive: true });
  const numbers = await iterationNumbers({ dir: skillEvalsDir, prefix });
  let candidate = (numbers[0] ?? 0) + 1;
  for (let attempt = 0; attempt < MAX_ITERATION_ATTEMPTS; attempt += 1) {
    const iterationDir = join(skillEvalsDir, `${prefix}-${candidate}`);
    try {
      await mkdir(iterationDir);
      return iterationDir;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      candidate += 1;
    }
  }
  throw new EvalError(
    `Could not allocate a new ${prefix} directory in ${skillEvalsDir}`,
  );
}

interface IterationNumbersParams {
  dir: string;
  prefix: string;
}

/** Iteration numbers found in `dir`, highest first. */
async function iterationNumbers({
  dir,
  prefix,
}: IterationNumbersParams): Promise<number[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const numbers: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = pattern.exec(entry.name);
    if (match?.[1]) numbers.push(Number.parseInt(match[1], 10));
  }
  return numbers.sort((left, right) => right - left);
}

export interface FindLatestIterationDirParams {
  evalsRootDir: string;
  skillName: string;
}

/** The newest iteration that finished, i.e. has a benchmark.json. */
export async function findLatestIterationDir({
  evalsRootDir,
  skillName,
}: FindLatestIterationDirParams): Promise<string> {
  const skillEvalsDir = join(evalsRootDir, skillName);
  if (!(await isDirectory(skillEvalsDir))) {
    throw new EvalError(`No evaluation iterations found for "${skillName}"`);
  }
  const numbers = await iterationNumbers({
    dir: skillEvalsDir,
    prefix: 'iteration',
  });
  for (const num of numbers) {
    const iterationDir = join(skillEvalsDir, `iteration-${num}`);
    const benchmark = await statIfExists(join(iterationDir, 'benchmark.json'));
    if (benchmark?.isFile()) return iterationDir;
  }
  throw new EvalError(
    numbers.length === 0
      ? `No evaluation iterations found for "${skillName}"`
      : `No completed evaluation iterations found for "${skillName}" (${numbers.length} without benchmark.json)`,
  );
}

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

  const records = await runWithConcurrency({
    items: jobs,
    concurrency: parallel,
    async worker(job) {
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

      if (prepared.possiblyContaminated) {
        possiblyContaminated = true;
      }
      if (prepared.warning && !warnings.has(prepared.warning)) {
        warnings.add(prepared.warning);
        onLog?.(`warning: ${prepared.warning}`);
      }

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
            ? `${label}: ${grading.summary.passed}/${grading.summary.total} passed (${timing.total_duration_seconds}s)`
            : `${label}: agent run failed: ${timing.error}`,
        );

        const record: EvalRunRecord = {
          case_id: job.evalCase.id,
          prompt: job.evalCase.prompt,
          variant: job.variant,
          run_index: job.runIndex,
          grading,
          timing,
        };
        return record;
      } finally {
        if (!keepWorkdirs) {
          await rm(prepared.workdir, { recursive: true, force: true });
        }
      }
    },
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

export interface RunSkillTriggersParams {
  skillName: string;
  skillDir: string;
  evalsRootDir: string;
  runner: EvalRunner;
  split?: TriggerSplit;
  runs?: number;
  threshold?: number;
  parallel?: number;
  timeoutSeconds?: number;
  sandbox?: boolean;
  keepWorkdirs?: boolean;
  paths?: Paths;
  env?: Environment;
  onLog?: (line: string) => void;
}

export interface RunSkillTriggersResult {
  outputDir: string;
  summary: TriggerBenchmarkSummary;
  reportMarkdown: string;
}

interface TriggerJob {
  queryIndex: number;
  query: string;
  shouldTrigger: boolean;
  runIndex: number;
}

export async function runSkillTriggers({
  skillName,
  skillDir,
  evalsRootDir,
  runner,
  split = 'all',
  runs = 1,
  threshold = 0.5,
  parallel = 2,
  timeoutSeconds = 120,
  sandbox = false,
  keepWorkdirs = false,
  paths,
  env,
  onLog,
}: RunSkillTriggersParams): Promise<RunSkillTriggersResult> {
  const allQueries = await loadTriggerQueries(skillDir);
  const selectedQueries = selectTriggerQueries(allQueries, split);
  const warnings: string[] = [];
  if (split !== 'all') {
    warnings.push(...splitTriggerQueries(allQueries).warnings);
  }
  // Every trigger workspace stages the same skill, so a personal skill that
  // shadows it affects every run: check once.
  const shadowWarning = await personalSkillShadowWarning({
    runner: runner.name,
    skillName,
    paths,
  });
  if (shadowWarning !== undefined) warnings.push(shadowWarning);
  for (const warning of warnings) onLog?.(`warning: ${warning}`);
  await runner.preflight?.();
  const outputDir = await allocateIterationDir({
    evalsRootDir,
    skillName,
    prefix: 'triggers',
  });

  const jobs: TriggerJob[] = [];
  for (const [queryIndex, item] of selectedQueries.entries()) {
    for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
      jobs.push({
        queryIndex: queryIndex + 1,
        query: item.query,
        shouldTrigger: item.should_trigger,
        runIndex,
      });
    }
  }

  const results = await runWithConcurrency({
    items: jobs,
    concurrency: parallel,
    async worker(job) {
      const runDir = join(
        outputDir,
        `query-${job.queryIndex}`,
        `run-${job.runIndex}`,
      );
      await mkdir(runDir, { recursive: true });
      const workdir = await prepareTriggerWorkspace({
        runDir,
        skillDir,
        skillName,
        runner: runner.name,
        env,
      });
      try {
        const startedAt = Date.now();
        let triggered = false;
        let durationMs: number;
        let failure: string | undefined;
        try {
          const taskResult = await runner.runTask({
            prompt: job.query,
            workdir,
            runDir,
            skillName,
            timeoutSeconds,
            sandbox,
          });
          triggered = taskResult.triggered;
          durationMs = taskResult.durationMs;
          failure = runFailure({ taskResult, timeoutSeconds });
        } catch (error) {
          durationMs = Date.now() - startedAt;
          failure = error instanceof Error ? error.message : String(error);
        }
        const runResult: TriggerQueryRunResult = {
          query: job.query,
          should_trigger: job.shouldTrigger,
          triggered,
          duration_ms: durationMs,
        };
        onLog?.(
          `[query ${job.queryIndex}] run ${job.runIndex}/${runs}: triggered=${triggered} (expected=${job.shouldTrigger})${failure === undefined ? '' : `; agent run failed: ${failure}`}`,
        );
        return runResult;
      } finally {
        if (!keepWorkdirs) {
          await rm(workdir, { recursive: true, force: true });
        }
      }
    },
  });

  const summary = aggregateTriggerRuns({
    skillName,
    skillPath: skillDir,
    runner: runner.name,
    split,
    runsPerQuery: runs,
    threshold,
    queries: selectedQueries,
    results,
    possiblyContaminated: shadowWarning !== undefined,
    warnings,
  });
  const reportMarkdown = renderTriggerReport(summary);

  await writeFile(
    join(outputDir, 'triggers.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(join(outputDir, 'triggers.md'), reportMarkdown);

  return {
    outputDir,
    summary,
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
