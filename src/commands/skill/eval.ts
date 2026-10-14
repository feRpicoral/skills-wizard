import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { styleText } from 'node:util';

import type { Context } from '../../context.ts';
import { UsageError } from '../../errors.ts';
import {
  type BenchmarkSummary,
  loadBenchmarkFromIteration,
} from '../../evals/aggregate.ts';
import type { TriggerSplit } from '../../evals/cases.ts';
import {
  regenerateSkillReport,
  runSkillEval,
  runSkillTriggers,
} from '../../evals/engine.ts';
import { formatPassRateDelta, formatRate } from '../../evals/report.ts';
import {
  createEvalRunner,
  detectDefaultRunner,
  type EvalRunner,
  type EvalRunnerName,
  parseEvalRunnerName,
} from '../../evals/runners/index.ts';
import { displayPath } from '../../install/describe.ts';
import { isDirectory, lstatIfExists } from '../../install/fs.ts';
import { isSkillName } from '../../skills/validate.ts';
import type { SkillCommandOptions } from '../skill.ts';

const WARN_LABEL = styleText('yellow', 'warn ');

const TRIGGER_SPLITS: readonly TriggerSplit[] = ['train', 'validation', 'all'];

function parseSplit(value: string | undefined): TriggerSplit {
  if (value === undefined) return 'all';
  const found = TRIGGER_SPLITS.find((item) => item === value);
  if (!found) {
    throw new UsageError(
      `--split must be one of ${TRIGGER_SPLITS.join(', ')}, got "${value}"`,
    );
  }
  return found;
}

interface ResolveTargetSkillParams {
  ctx: Context;
  nameOrPath: string;
}

export async function resolveTargetSkill({
  ctx,
  nameOrPath,
}: ResolveTargetSkillParams): Promise<{ skillName: string; skillDir: string }> {
  const cwdSkillDir = join(ctx.cwd, 'skills', nameOrPath);
  if (isSkillName(nameOrPath) && (await isDirectory(cwdSkillDir))) {
    return { skillName: nameOrPath, skillDir: cwdSkillDir };
  }
  const repoSkillDir = join(ctx.repoRoot, 'skills', nameOrPath);
  if (isSkillName(nameOrPath) && (await isDirectory(repoSkillDir))) {
    return { skillName: nameOrPath, skillDir: repoSkillDir };
  }
  const resolved = resolve(ctx.cwd, nameOrPath);
  if (await isDirectory(resolved)) {
    const skillName = basename(resolved);
    if (!isSkillName(skillName)) {
      throw new UsageError(
        `Skill directory name "${skillName}" is not a valid skill name`,
      );
    }
    return { skillName, skillDir: resolved };
  }
  throw new UsageError(`Skill "${nameOrPath}" was not found in skills/`);
}

interface WarnUnsupportedSandboxParams {
  ctx: Context;
  runner: EvalRunner;
  sandbox: boolean;
}

/** Warns when --sandbox was requested but the runner cannot honor it. */
export function warnUnsupportedSandbox({
  ctx,
  runner,
  sandbox,
}: WarnUnsupportedSandboxParams): void {
  if (!sandbox || runner.sandboxSupported !== false) return;
  ctx.print(
    `${WARN_LABEL}  --sandbox is not supported by the ${runner.name} runner; its runs are not sandboxed and use your real home directory.`,
  );
}

interface ResolveEvalRunnerParams {
  ctx: Context;
  rawRunner: string | undefined;
  binary: string | undefined;
  sandbox: boolean;
}

export async function resolveEvalRunner({
  ctx,
  rawRunner,
  binary,
  sandbox,
}: ResolveEvalRunnerParams): Promise<EvalRunner> {
  let runnerName: EvalRunnerName;
  // --binary wins over AGY_BIN, so AGY_BIN is not read (or validated) then;
  // otherwise it is read only for auto-detection and agy runs.
  const readAgyBin = () => (binary ? undefined : ctx.agy?.bin());
  let agyBin: string | undefined;
  if (rawRunner) {
    runnerName = parseEvalRunnerName(rawRunner);
    if (runnerName === 'agy') agyBin = readAgyBin();
  } else {
    agyBin = readAgyBin();
    runnerName = await detectDefaultRunner({
      searchPath: ctx.searchPath,
      ...(agyBin ? { agyConfig: { bin: agyBin, extraArgs: [] } } : {}),
    });
  }
  const agyConfig =
    runnerName === 'agy'
      ? {
          ...(agyBin ? { bin: agyBin } : {}),
          extraArgs: ctx.agy?.extraArgs() ?? [],
        }
      : undefined;
  const runner = createEvalRunner({
    runner: runnerName,
    binary,
    cwd: ctx.cwd,
    agyConfig,
    env: ctx.sources.env,
  });
  warnUnsupportedSandbox({ ctx, runner, sandbox });
  return runner;
}

interface ResolveReportDirParams {
  ctx: Context;
  args: readonly string[];
}

export interface ResolvedReportDir {
  skillName?: string;
  iterationDir?: string;
}

export async function resolveReportDir({
  ctx,
  args,
}: ResolveReportDirParams): Promise<ResolvedReportDir> {
  const [first, second] = args;
  if (first === undefined) return {};
  if (second === undefined) {
    const candidateDir = resolve(ctx.cwd, first);
    if ((await lstatIfExists(join(candidateDir, 'benchmark.json'))) !== null) {
      return { iterationDir: candidateDir };
    }
    if (!isSkillName(first)) {
      throw new UsageError(
        `"${first}" is neither a skill name nor a directory containing benchmark.json`,
      );
    }
    return { skillName: first };
  }
  if (!isSkillName(first)) {
    throw new UsageError(`Invalid skill name "${first}"`);
  }
  if (isAbsolute(second)) return { skillName: first, iterationDir: second };
  const fromCwd = resolve(ctx.cwd, second);
  if ((await lstatIfExists(fromCwd)) !== null) {
    return { skillName: first, iterationDir: fromCwd };
  }
  const skillEvalsDir = join(ctx.paths.evalsDir, first);
  const fromEvals = resolve(skillEvalsDir, second);
  const inside = relative(skillEvalsDir, fromEvals);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new UsageError(
      `Iteration directory "${second}" must be inside the ${first} evals directory`,
    );
  }
  return { skillName: first, iterationDir: fromEvals };
}

export function printBenchmarkSummary(
  ctx: Context,
  benchmark: BenchmarkSummary,
): void {
  const { metadata, run_summary: summary } = benchmark;
  const withMean = formatRate(summary.with_skill.pass_rate.mean);
  const deltas = [
    ...(summary.without_skill
      ? [
          `${formatPassRateDelta(summary.with_skill, summary.without_skill)} vs baseline`,
        ]
      : []),
    ...(summary.old_skill
      ? [
          `${formatPassRateDelta(summary.with_skill, summary.old_skill)} vs old_skill`,
        ]
      : []),
  ];
  const deltaStr = deltas.length > 0 ? ` (${deltas.join(', ')})` : '';
  ctx.print(
    `Evaluated ${metadata.skill_name} with ${metadata.runner}: with_skill pass rate ${withMean}${deltaStr}.`,
  );
}

export async function runSkillEvalCommand(
  ctx: Context,
  {
    paths,
    runner: rawRunner,
    binary,
    runs,
    baseline,
    compare,
    caseId,
    cases,
    parallel,
    timeout,
    sandbox = false,
    keepWorkdirs = false,
  }: SkillCommandOptions,
): Promise<number> {
  if (paths.length !== 1 || !paths[0]) {
    throw new UsageError(
      'Usage: agents-config skill eval <name> [--runner <name>] [--runs <n>] [--baseline|--no-baseline|--baseline none|<ref>] [--compare <ref>] [--case <id>] [--cases <ids>] [--parallel <n>] [--timeout <s>] [--sandbox] [--keep-workdirs]',
    );
  }
  const { skillName, skillDir } = await resolveTargetSkill({
    ctx,
    nameOrPath: paths[0],
  });
  const runner = await resolveEvalRunner({ ctx, rawRunner, binary, sandbox });
  const result = await runSkillEval({
    skillName,
    skillDir,
    evalsRootDir: ctx.paths.evalsDir,
    runner,
    runs: runs ?? 1,
    baseline: baseline ?? true,
    compareRef: compare,
    caseId,
    caseIds: cases,
    parallel: parallel ?? 2,
    timeoutSeconds: timeout ?? 600,
    sandbox,
    keepWorkdirs,
    paths: ctx.paths,
    env: ctx.sources.env,
    onLog: (line) => ctx.print(line),
  });
  printBenchmarkSummary(ctx, result.benchmark);
  ctx.print(
    `Report: ${displayPath({ path: join(result.iterationDir, 'report.md'), home: ctx.paths.home })}`,
  );
  return 0;
}

export async function runSkillTriggersCommand(
  ctx: Context,
  {
    paths,
    runner: rawRunner,
    binary,
    runs,
    parallel,
    timeout,
    sandbox = false,
    keepWorkdirs = false,
    split: rawSplit,
    threshold: rawThreshold,
  }: SkillCommandOptions,
): Promise<number> {
  if (paths.length !== 1 || !paths[0]) {
    throw new UsageError(
      'Usage: agents-config skill triggers <name> [--runner <name>] [--split train|validation|all] [--runs <n>] [--threshold <0..1>] [--parallel <n>] [--timeout <s>] [--sandbox] [--keep-workdirs]',
    );
  }
  const { skillName, skillDir } = await resolveTargetSkill({
    ctx,
    nameOrPath: paths[0],
  });
  const split = parseSplit(rawSplit);
  const threshold = rawThreshold ?? 0.5;
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    throw new UsageError('--threshold must be a number between 0 and 1');
  }
  const runner = await resolveEvalRunner({ ctx, rawRunner, binary, sandbox });
  const result = await runSkillTriggers({
    skillName,
    skillDir,
    evalsRootDir: ctx.paths.evalsDir,
    runner,
    split,
    runs: runs ?? 1,
    threshold,
    parallel: parallel ?? 2,
    timeoutSeconds: timeout ?? 120,
    sandbox,
    keepWorkdirs,
    paths: ctx.paths,
    env: ctx.sources.env,
    onLog: (line) => ctx.print(line),
  });
  const { metrics } = result.summary;
  const excluded =
    metrics.errored_queries > 0
      ? `, ${metrics.errored_queries}/${metrics.total_queries} queries excluded (failed runs)`
      : '';
  ctx.print(
    `Triggers for ${skillName} (${split}): recall ${formatRate(metrics.recall)}, precision ${formatRate(metrics.precision)}, false positive rate ${formatRate(metrics.false_positive_rate)}, accuracy ${formatRate(metrics.accuracy)}${excluded}.`,
  );
  ctx.print(
    `Report: ${displayPath({ path: join(result.outputDir, 'triggers.md'), home: ctx.paths.home })}`,
  );
  return 0;
}

export async function runSkillReportCommand(
  ctx: Context,
  { paths }: SkillCommandOptions,
): Promise<number> {
  if (paths.length < 1 || paths.length > 2 || !paths[0]) {
    throw new UsageError(
      'Usage: agents-config skill report <name|run-dir> [iteration-dir]',
    );
  }
  const target = await resolveReportDir({ ctx, args: paths });
  if (target.skillName !== undefined && target.iterationDir !== undefined) {
    const { metadata } = await loadBenchmarkFromIteration(target.iterationDir);
    if (metadata.skill_name !== target.skillName) {
      throw new UsageError(
        `${displayPath({ path: target.iterationDir, home: ctx.paths.home })} holds a benchmark for "${metadata.skill_name}", not "${target.skillName}"`,
      );
    }
  }
  const result = await regenerateSkillReport({
    evalsRootDir: ctx.paths.evalsDir,
    ...target,
  });
  printBenchmarkSummary(ctx, result.benchmark);
  ctx.print(
    `Rendered report: ${displayPath({ path: join(result.iterationDir, 'report.md'), home: ctx.paths.home })}`,
  );
  return 0;
}
