import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import {
  aggregateTriggerRuns,
  type TriggerBenchmarkSummary,
  type TriggerQueryRunResult,
} from './aggregate.ts';
import {
  loadTriggerQueries,
  selectTriggerQueries,
  splitTriggerQueries,
  type TriggerSplit,
} from './cases.ts';
import { runFailure } from './grade.ts';
import { allocateIterationDir, removeWorkdir } from './iterations.ts';
import { renderTriggerReport } from './report.ts';
import type { EvalRunner } from './runners/types.ts';
import {
  personalSkillShadowWarning,
  prepareTriggerWorkspace,
} from './workspace.ts';

export interface BoundedConcurrencyParams<T, R> {
  items: readonly T[];
  concurrency: number;
  worker: (item: T, index: number) => Promise<R>;
}

// Workers catch their own per-job failures, so an error reaching this loop is
// fatal: no new jobs start, the running ones finish, then the error is thrown.
export async function runWithConcurrency<T, R>({
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

/**
 * Runs a skill trigger evaluation across the selected `train`, `validation`,
 * or `all` query split, records whether the skill was read on each run, and
 * writes `triggers.json` and `triggers.md` into a newly allocated
 * `triggers-<N>` directory.
 */
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
          ...(failure !== undefined ? { error: failure } : {}),
        };
        onLog?.(
          `[query ${job.queryIndex}] run ${job.runIndex}/${runs}: triggered=${triggered} (expected=${job.shouldTrigger})${failure === undefined ? '' : `; agent run failed: ${failure}`}`,
        );
        return runResult;
      } finally {
        if (!keepWorkdirs) {
          await removeWorkdir({ path: workdir, onLog });
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
