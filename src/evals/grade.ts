import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Environment } from '../env.ts';
import {
  buildBlindGraderPrompt,
  type BuildBlindGraderPromptParams,
  failedString,
  GRADER_JSON_SCHEMA,
  normalizeGraderResults,
  type NormalizeGraderResultsParams,
} from './blind-grader.ts';
import type { EvalCase, ScriptedAssertion } from './cases.ts';
import type { EvalRunner, RunnerTaskResult } from './runners/types.ts';
import {
  evaluateScriptedAssertion,
  type EvaluateScriptedAssertionParams,
  formatAssertionLabel,
  runShellCommand,
  type RunShellCommandParams,
  type ShellCommandResult,
} from './scripted-assertions.ts';
import {
  byteLength,
  capResponse,
  LISTING_BUDGET_BYTES,
  PROMPT_BUDGET_BYTES,
  summarizeWorkspace,
  type SummarizeWorkspaceParams,
  utf8Head,
  utf8Tail,
  WORKSPACE_SUMMARY_BUDGET,
} from './workspace-summary.ts';

export {
  buildBlindGraderPrompt,
  type BuildBlindGraderPromptParams,
  capResponse,
  evaluateScriptedAssertion,
  type EvaluateScriptedAssertionParams,
  formatAssertionLabel,
  GRADER_JSON_SCHEMA,
  normalizeGraderResults,
  type NormalizeGraderResultsParams,
  runShellCommand,
  type RunShellCommandParams,
  type ShellCommandResult,
  summarizeWorkspace,
  type SummarizeWorkspaceParams,
  utf8Head,
  utf8Tail,
};

const GRADER_DIR_PREFIX = 'agents-config-grader-';

export interface GradedExpectation {
  text: string;
  kind: 'string' | ScriptedAssertion['type'];
  passed: boolean;
  evidence: string;
}

export interface GradingSummary {
  passed: number;
  failed: number;
  total: number;
  pass_rate: number;
}

export interface GradingReport {
  expectations: GradedExpectation[];
  summary: GradingSummary;
}

export interface TimingReport {
  duration_ms: number;
  total_duration_seconds: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  triggered: boolean;
  exit_code: number;
  timed_out: boolean;
  /** False when the runner reported no token usage; token fields are then 0. */
  usage_reported?: boolean;
  /** Why the agent run failed, when it did. */
  error?: string;
}

export interface RunFailureParams {
  taskResult: RunnerTaskResult;
  timeoutSeconds: number;
}

/** Why the agent run failed, or undefined when it completed. */
export function runFailure({
  taskResult,
  timeoutSeconds,
}: RunFailureParams): string | undefined {
  if (taskResult.error) return taskResult.error;
  if (taskResult.timedOut) return `Timed out after ${timeoutSeconds}s`;
  return undefined;
}

export interface GradeResult {
  grading: GradingReport;
  timing: TimingReport;
}

interface WriteRunReportsParams {
  runDir: string;
  expectations: GradedExpectation[];
  taskResult: RunnerTaskResult;
  error?: string;
}

async function writeRunReports({
  runDir,
  expectations,
  taskResult,
  error,
}: WriteRunReportsParams): Promise<GradeResult> {
  const passed = expectations.filter((item) => item.passed).length;
  const total = expectations.length;
  const failed = total - passed;
  // Stored exactly; reports round when rendering.
  const passRate = total === 0 ? 1 : passed / total;

  const grading: GradingReport = {
    expectations,
    summary: {
      passed,
      failed,
      total,
      pass_rate: passRate,
    },
  };

  const timing: TimingReport = {
    duration_ms: taskResult.durationMs,
    total_duration_seconds: taskResult.durationMs / 1000,
    input_tokens: taskResult.usage.input_tokens,
    output_tokens: taskResult.usage.output_tokens,
    total_tokens: taskResult.usage.total_tokens,
    triggered: taskResult.triggered,
    exit_code: taskResult.exitCode,
    timed_out: taskResult.timedOut,
    usage_reported:
      taskResult.usageReported ?? taskResult.usage.total_tokens > 0,
    ...(error === undefined ? {} : { error }),
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'grading.json'),
    `${JSON.stringify(grading, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, 'timing.json'),
    `${JSON.stringify(timing, null, 2)}\n`,
  );

  return { grading, timing };
}

function failedExpectations(
  evalCase: EvalCase,
  evidence: string,
): GradedExpectation[] {
  return evalCase.assertions.map((assertion) => ({
    text: formatAssertionLabel(assertion),
    kind: typeof assertion === 'string' ? 'string' : assertion.type,
    passed: false,
    evidence,
  }));
}

export interface RecordFailedRunParams {
  evalCase: EvalCase;
  runDir: string;
  error: string;
  durationMs: number;
}

/**
 * Records a run whose agent could not run at all (the runner threw): every
 * assertion fails and timing carries the error.
 */
export async function recordFailedRun({
  evalCase,
  runDir,
  error,
  durationMs,
}: RecordFailedRunParams): Promise<GradeResult> {
  return writeRunReports({
    runDir,
    expectations: failedExpectations(evalCase, `Agent run failed: ${error}`),
    taskResult: {
      response: '',
      triggered: false,
      durationMs,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      exitCode: 1,
      timedOut: false,
      rawStdout: '',
      rawStderr: '',
      usageReported: false,
    },
    error,
  });
}

interface GradeStringAssertionsParams {
  evalCase: EvalCase;
  workdir: string;
  runDir: string;
  rawResponse: string;
  stringAssertions: readonly string[];
  runner: EvalRunner;
  timeoutSeconds: number;
}

/**
 * Summarizes the workspace within the prompt byte budget, runs the blind grader
 * in an isolated temporary directory, and normalizes its verdicts.
 */
async function gradeStringAssertions({
  evalCase,
  workdir,
  runDir,
  rawResponse,
  stringAssertions,
  runner,
  timeoutSeconds,
}: GradeStringAssertionsParams): Promise<GradedExpectation[]> {
  const schemaPath = join(runDir, 'grader-schema.json');
  await writeFile(
    schemaPath,
    `${JSON.stringify(GRADER_JSON_SCHEMA, null, 2)}\n`,
  );

  const response = capResponse(rawResponse);
  // Whatever the fixed parts of the prompt leave, up to the summary budget.
  const fixedBytes = byteLength(
    buildBlindGraderPrompt({
      evalCase,
      response,
      workspaceSummary: [],
      stringAssertions,
    }),
  );
  const workspaceSummary = await summarizeWorkspace({
    workdir,
    budget: Math.max(
      0,
      Math.min(
        WORKSPACE_SUMMARY_BUDGET,
        PROMPT_BUDGET_BYTES - fixedBytes - 2 * LISTING_BUDGET_BYTES,
      ),
    ),
  });
  const prompt = buildBlindGraderPrompt({
    evalCase,
    response,
    workspaceSummary,
    stringAssertions,
  });

  // The grader runs in an empty temporary folder whose path names neither
  // the variant nor the run, away from the workspace it could otherwise
  // read (revealing the variant) or change. Its logs stay in runDir.
  const graderDir = await mkdtemp(join(tmpdir(), GRADER_DIR_PREFIX));

  try {
    const graderResult = await runner.runGrader({
      prompt,
      schemaPath,
      schema: GRADER_JSON_SCHEMA,
      workdir: graderDir,
      runDir,
      timeoutSeconds,
    });

    return normalizeGraderResults({
      assertions: stringAssertions,
      output: graderResult.output,
      evidenceText: [response, ...workspaceSummary].join('\n'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return stringAssertions.map((assertion) =>
      failedString(assertion, `Grader error: ${message}`),
    );
  } finally {
    await rm(graderDir, { recursive: true, force: true });
  }
}

export interface GradeEvalRunParams {
  evalCase: EvalCase;
  workdir: string;
  runDir: string;
  taskResult: RunnerTaskResult;
  runner: EvalRunner;
  timeoutSeconds: number;
  env: Environment;
}

/**
 * Evaluates all scripted and natural-language assertions for a single agent run
 * and writes `grading.json` and `timing.json` into `runDir`. If the agent run
 * timed out or reported an error, all assertions are marked failed without
 * invoking the blind grader.
 */
export async function gradeEvalRun({
  evalCase,
  workdir,
  runDir,
  taskResult,
  runner,
  timeoutSeconds,
  env,
}: GradeEvalRunParams): Promise<GradeResult> {
  await mkdir(runDir, { recursive: true });

  const failure = runFailure({ taskResult, timeoutSeconds });

  if (failure !== undefined) {
    return writeRunReports({
      runDir,
      expectations: failedExpectations(
        evalCase,
        `Agent run failed: ${failure}`,
      ),
      taskResult,
      error: failure,
    });
  }

  const scriptedByIndex = new Map<number, GradedExpectation>();
  const stringAssertions: string[] = [];
  const stringIndexes: number[] = [];

  for (const [index, assertion] of evalCase.assertions.entries()) {
    if (typeof assertion === 'string') {
      stringAssertions.push(assertion);
      stringIndexes.push(index);
    } else {
      scriptedByIndex.set(
        index,
        await evaluateScriptedAssertion({
          assertion,
          workdir,
          env,
        }),
      );
    }
  }

  const gradedStrings = new Map<number, GradedExpectation>();

  if (stringAssertions.length > 0) {
    const normalized = await gradeStringAssertions({
      evalCase,
      workdir,
      runDir,
      rawResponse: taskResult.response,
      stringAssertions,
      runner,
      timeoutSeconds,
    });

    for (const [position, item] of normalized.entries()) {
      const index = stringIndexes[position];
      if (index !== undefined) gradedStrings.set(index, item);
    }
  }

  const expectations: GradedExpectation[] = evalCase.assertions.map(
    (assertion, index) => {
      if (typeof assertion === 'string') {
        return (
          gradedStrings.get(index) ??
          failedString(
            assertion,
            'Grader did not return a result for this assertion.',
          )
        );
      }

      return (
        scriptedByIndex.get(index) ?? {
          text: formatAssertionLabel(assertion),
          kind: assertion.type,
          passed: false,
          evidence: 'Scripted assertion was not evaluated.',
        }
      );
    },
  );

  return writeRunReports({ runDir, expectations, taskResult });
}
