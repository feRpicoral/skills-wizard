import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { isDirectory } from '../install/fs.ts';
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
  type TriggerSplit,
} from './cases.ts';
import { gradeEvalRun } from './grade.ts';
import { renderBenchmarkReport, renderTriggerReport } from './report.ts';
import type { EvalRunner } from './runners/types.ts';
import {
  type EvalVariant,
  prepareEvalWorkspace,
  prepareTriggerWorkspace,
} from './workspace.ts';

interface BoundedConcurrencyParams<T, R> {
  items: readonly T[];
  concurrency: number;
  worker: (item: T, index: number) => Promise<R>;
}

async function runWithConcurrency<T, R>({
  items,
  concurrency,
  worker,
}: BoundedConcurrencyParams<T, R>): Promise<R[]> {
  const limit = Math.max(1, concurrency);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function next(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      const item = items[current];
      if (item !== undefined) {
        results[current] = await worker(item, current);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    next(),
  );
  await Promise.all(workers);
  return results;
}

export interface AllocateIterationDirParams {
  evalsRootDir: string;
  skillName: string;
  prefix?: string;
}

export async function allocateIterationDir({
  evalsRootDir,
  skillName,
  prefix = 'iteration',
}: AllocateIterationDirParams): Promise<string> {
  const skillEvalsDir = join(evalsRootDir, skillName);
  await mkdir(skillEvalsDir, { recursive: true });
  const entries = await readdir(skillEvalsDir, { withFileTypes: true });
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let maxNumber = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = pattern.exec(entry.name);
    if (match?.[1]) {
      const num = Number.parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }
  const iterationDir = join(skillEvalsDir, `${prefix}-${maxNumber + 1}`);
  await mkdir(iterationDir, { recursive: true });
  return iterationDir;
}

export interface FindLatestIterationDirParams {
  evalsRootDir: string;
  skillName: string;
}

export async function findLatestIterationDir({
  evalsRootDir,
  skillName,
}: FindLatestIterationDirParams): Promise<string> {
  const skillEvalsDir = join(evalsRootDir, skillName);
  if (!(await isDirectory(skillEvalsDir))) {
    throw new EvalError(`No evaluation iterations found for "${skillName}"`);
  }
  const entries = await readdir(skillEvalsDir, { withFileTypes: true });
  let maxNumber = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^iteration-(\d+)$/.exec(entry.name);
    if (match?.[1]) {
      const num = Number.parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  }
  if (maxNumber === 0) {
    throw new EvalError(`No evaluation iterations found for "${skillName}"`);
  }
  return join(skillEvalsDir, `iteration-${maxNumber}`);
}

export interface RunSkillEvalParams {
  skillName: string;
  skillDir: string;
  repoRoot: string;
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
  env?: Environment;
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
  repoRoot,
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

  const variants: EvalVariant[] = ['with_skill'];
  if (baseline) variants.push('without_skill');
  if (compareRef) variants.push('old_skill');

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
      const runDir = join(
        iterationDir,
        `eval-${job.evalCase.id}`,
        job.variant,
        `run-${job.runIndex}`,
      );
      await mkdir(runDir, { recursive: true });
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
        const taskResult = await runner.runTask({
          prompt: job.evalCase.prompt,
          workdir: prepared.workdir,
          runDir,
          skillName,
          timeoutSeconds,
          sandbox,
          excludeSkill: job.variant === 'without_skill',
        });

        const { grading, timing } = await gradeEvalRun({
          evalCase: job.evalCase,
          workdir: prepared.workdir,
          runDir,
          taskResult,
          runner,
          timeoutSeconds,
          env,
        });

        onLog?.(
          `[${job.evalCase.id}] ${job.variant} run ${job.runIndex}/${runs}: ${grading.summary.passed}/${grading.summary.total} passed (${timing.total_duration_seconds}s)`,
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
  env,
  onLog,
}: RunSkillTriggersParams): Promise<RunSkillTriggersResult> {
  const allQueries = await loadTriggerQueries(skillDir);
  const selectedQueries = selectTriggerQueries(allQueries, split);
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
        env,
      });
      try {
        const taskResult = await runner.runTask({
          prompt: job.query,
          workdir,
          runDir,
          skillName,
          timeoutSeconds,
          sandbox,
        });
        const runResult: TriggerQueryRunResult = {
          query: job.query,
          should_trigger: job.shouldTrigger,
          triggered: taskResult.triggered,
          duration_ms: taskResult.durationMs,
        };
        onLog?.(
          `[query ${job.queryIndex}] run ${job.runIndex}/${runs}: triggered=${taskResult.triggered} (expected=${job.shouldTrigger})`,
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
