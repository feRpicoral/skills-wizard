import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Environment, Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { statIfExists } from '../install/fs.ts';
import { runSetup } from '../skills/setup.ts';
import { copySkillTree, escapingLinks } from '../skills/tree.ts';
import { isSkillName } from '../skills/validate.ts';
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
import {
  allocateIterationDir,
  type AllocateIterationDirParams,
  findLatestIterationDir,
  type FindLatestIterationDirParams,
  removeWorkdir,
} from './iterations.ts';
import { renderBenchmarkReport, renderTriggerReport } from './report.ts';
import type { EvalRunner, RunnerTaskResult } from './runners/types.ts';
import {
  assertSafeGitRef,
  type ComparedSkillSpec,
  compareSkillVariant,
  type EvalVariant,
  parseCompareSkillVariant,
  personalSkillShadowWarning,
  prepareEvalWorkspace,
  prepareTriggerWorkspace,
  resolveSkillRepository,
  validateEvalSuiteFileDestinations,
  variantDirName,
  verifySkillAtRef,
} from './workspace.ts';

export {
  allocateIterationDir,
  type AllocateIterationDirParams,
  findLatestIterationDir,
  type FindLatestIterationDirParams,
};

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

async function validateComparedSkillSpecs(
  skillName: string,
  compareSkills: readonly ComparedSkillSpec[] | undefined,
): Promise<Map<string, ComparedSkillSpec>> {
  const compareSkillsByName = new Map<string, ComparedSkillSpec>();
  for (const item of compareSkills ?? []) {
    if (!isSkillName(item.skillName)) {
      throw new EvalError(
        `Compared skill name "${item.skillName}" is not a valid skill name`,
      );
    }
    if (item.skillName === skillName) {
      throw new EvalError(
        `Compared skill "${item.skillName}" must have a different name from the target skill "${skillName}"`,
      );
    }
    if (compareSkillsByName.has(item.skillName)) {
      throw new EvalError(
        `Duplicate compared skill name "${item.skillName}" in compareSkills`,
      );
    }
    const skillMd = await statIfExists(join(item.skillDir, 'SKILL.md'));
    if (!skillMd?.isFile()) {
      throw new EvalError(
        `Compared skill "${item.skillName}" is missing SKILL.md in ${item.skillDir}`,
      );
    }
    const itemEscaping = await escapingLinks(item.skillDir);
    if (itemEscaping.length > 0) {
      throw new EvalError(
        `Compared skill "${item.skillName}" has links that point outside the skill folder: ${itemEscaping.map((link) => `${link.path} -> ${link.target}`).join(', ')}`,
      );
    }
    compareSkillsByName.set(item.skillName, item);
  }
  return compareSkillsByName;
}

async function prepareComparedSkillSetups(
  compareSkillsByName: Map<string, ComparedSkillSpec>,
  tempDirs: string[],
): Promise<void> {
  for (const [name, item] of compareSkillsByName) {
    if (!item.setup) continue;
    const tempRoot = await mkdtemp(join(tmpdir(), 'agents-config-compare-'));
    tempDirs.push(tempRoot);
    const preparedDir = join(tempRoot, item.skillName);
    await copySkillTree({ source: item.skillDir, destination: preparedDir });
    await runSetup({ dir: preparedDir, command: item.setup });
    compareSkillsByName.set(name, {
      skillName: item.skillName,
      skillDir: preparedDir,
    });
  }
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

async function executeEvalJob({
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
}: ExecuteEvalJobParams): Promise<EvalRunRecord> {
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
    const startedAt = Date.now();
    let taskResult: RunnerTaskResult | undefined;
    let launchError: string | undefined;
    try {
      taskResult = await runner.runTask({
        prompt: job.evalCase.prompt,
        workdir: prepared.workdir,
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
 * (`with_skill`, optional `without_skill` baseline, optional `old_skill`
 * at `compareRef`, and optional competing `compareSkills`), grades each run,
 * and writes `benchmark.json` and `report.md` into a newly allocated
 * `iteration-<N>` directory.
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
  compareSkills,
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
  if (
    compareRef !== undefined &&
    compareSkills !== undefined &&
    compareSkills.length > 0
  ) {
    throw new EvalError(
      'Cannot combine compareRef and compareSkills in the same evaluation',
    );
  }
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

  // Everything that can fail for every job is checked before the iteration
  // directory exists, so a bad ref or a missing CLI leaves nothing behind.
  await runner.preflight?.();
  let repoRoot: string | undefined;
  if (compareRef !== undefined) {
    assertSafeGitRef(compareRef);
    repoRoot = await resolveSkillRepository({ skillDir, env });
    await verifySkillAtRef({ repoRoot, skillDir, ref: compareRef, env });
  }

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
              flags.variant !== 'without_skill' &&
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

    return {
      iterationDir,
      benchmark,
      reportMarkdown,
    };
  } finally {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  }
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
