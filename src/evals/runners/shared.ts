import { mkdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { Environment } from '../../env.ts';
import { RunnerError } from '../../errors.ts';
import { isRecord as isRecordObject } from '../../frontmatter.ts';
import { checkRunnerBinary, spawnRunnerProcess } from './process.ts';
import type {
  EvalRunner,
  EvalRunnerName,
  ParsedGraderOutput,
  ParsedTaskStream,
  RunnerGraderRequest,
  RunnerGraderResult,
  RunnerTaskRequest,
  RunnerTaskResult,
  RunnerUsage,
  SpawnRunnerProcessResult,
} from './types.ts';

export { isRecordObject };

export function emptyUsage(): RunnerUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Normalizes a usage object with `input_tokens`/`output_tokens`/`total_tokens`.
 * Anthropic-style cache counters (`cache_creation_input_tokens`,
 * `cache_read_input_tokens`) are reported separately from `input_tokens`, so
 * they are added to the input count.
 */
export function normalizeUsage(raw: unknown): RunnerUsage {
  if (typeof raw !== 'object' || raw === null) {
    return emptyUsage();
  }
  const record = raw as Record<string, unknown>;
  const input =
    tokenCount(record.input_tokens) +
    tokenCount(record.cache_creation_input_tokens) +
    tokenCount(record.cache_read_input_tokens);
  const output = tokenCount(record.output_tokens);
  const total =
    typeof record.total_tokens === 'number'
      ? tokenCount(record.total_tokens)
      : input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

/**
 * Whether a raw usage object reports real usage: at least one `*tokens`
 * counter above zero. All-zero counters (e.g. on failed runs) count as not
 * reported, so they are excluded from token statistics.
 */
export function isUsageReported(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return false;
  }
  return Object.entries(raw).some(
    ([key, value]) =>
      key.endsWith('tokens') && typeof value === 'number' && value > 0,
  );
}

/**
 * Whether `text` references the staged skill file `skills/<name>/SKILL.md`
 * with a path boundary before `skills`, so `other-<name>/SKILL.md` or
 * `fixtures/<name>/SKILL.md` do not count as a trigger.
 */
export function mentionsSkillFile(text: string, skillName: string): boolean {
  if (!skillName) return false;
  const normalized = text.replaceAll('\\', '/');
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9._-])skills/${RegExp.escape(skillName)}/SKILL\\.md(?![A-Za-z0-9._-])`,
  );
  return pattern.test(normalized);
}

export function parseJsonLines(text: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecordObject(parsed)) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}

export function parseJsonDocument(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecordObject(parsed)) {
      return parsed;
    }
  } catch {
    const events = parseJsonLines(trimmed);
    const last = events.at(-1);
    if (last) return last;
  }
  throw new RunnerError('Runner did not return a valid JSON object');
}

export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new RunnerError(
      `Grader response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

const STDERR_TAIL_CHARS = 400;

/** The last few hundred characters of stderr, on one line. */
export function stderrTail(stderr: string): string {
  const collapsed = stderr.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= STDERR_TAIL_CHARS) return collapsed;
  return `…${collapsed.slice(-STDERR_TAIL_CHARS)}`;
}

function withStderr(message: string, stderr: string): string {
  const tail = stderrTail(stderr);
  return tail ? `${message}; stderr: ${tail}` : message;
}

export interface DescribeProcessFailureParams {
  label: string;
  proc: SpawnRunnerProcessResult;
  timeoutSeconds: number;
  /** Error reported by the CLI's own output, if any. */
  reportedError?: string;
  /** Whether the CLI emitted a final result. */
  sawResult: boolean;
}

/**
 * Why a runner process failed, or undefined when it succeeded. Precedence:
 * timeout, error reported by the CLI, non-zero exit, missing final result.
 */
export function describeProcessFailure({
  label,
  proc,
  timeoutSeconds,
  reportedError,
  sawResult,
}: DescribeProcessFailureParams): string | undefined {
  if (proc.timedOut) {
    return withStderr(
      `${label} timed out after ${timeoutSeconds}s`,
      proc.stderr,
    );
  }
  if (reportedError !== undefined) {
    return withStderr(`${label} reported an error: ${reportedError}`, '');
  }
  if (proc.exitCode !== 0) {
    return withStderr(
      `${label} exited with code ${proc.exitCode}`,
      proc.stderr,
    );
  }
  if (!sawResult) {
    return withStderr(
      `${label} output ended without a final result event`,
      proc.stderr,
    );
  }
  return undefined;
}

export interface BuildTaskResultParams {
  label: string;
  proc: SpawnRunnerProcessResult;
  parsed: ParsedTaskStream;
  timeoutSeconds: number;
}

/** Turns a finished process and its parsed stream into a task result. */
export function buildTaskResult({
  label,
  proc,
  parsed,
  timeoutSeconds,
}: BuildTaskResultParams): RunnerTaskResult {
  const error = describeProcessFailure({
    label,
    proc,
    timeoutSeconds,
    reportedError: parsed.error,
    sawResult: parsed.sawResult,
  });
  return {
    response: parsed.response,
    triggered: parsed.triggered,
    durationMs: parsed.durationMs,
    usage: parsed.usage,
    usageReported: parsed.usageReported,
    exitCode: proc.exitCode,
    timedOut: proc.timedOut,
    rawStdout: proc.stdout,
    rawStderr: proc.stderr,
    ...(error !== undefined ? { error } : {}),
  };
}

export interface ParseGraderProcessParams {
  label: string;
  proc: SpawnRunnerProcessResult;
  timeoutSeconds: number;
  parse: () => ParsedGraderOutput;
}

/**
 * Parses grader output, throwing RunnerError (with the stderr tail) when the
 * grader timed out, exited non-zero or returned an unusable result.
 */
export function parseGraderProcess({
  label,
  proc,
  timeoutSeconds,
  parse,
}: ParseGraderProcessParams): RunnerGraderResult {
  if (proc.timedOut) {
    throw new RunnerError(
      withStderr(`${label} timed out after ${timeoutSeconds}s`, proc.stderr),
    );
  }
  let parsed: ParsedGraderOutput;
  try {
    parsed = parse();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message =
      proc.exitCode !== 0
        ? `${label} exited with code ${proc.exitCode}: ${reason}`
        : reason;
    throw new RunnerError(withStderr(message, proc.stderr), { cause: error });
  }
  if (proc.exitCode !== 0) {
    throw new RunnerError(
      withStderr(`${label} exited with code ${proc.exitCode}`, proc.stderr),
    );
  }
  return {
    ...parsed,
    rawStdout: proc.stdout,
    rawStderr: proc.stderr,
  };
}

export interface CreateCliRunnerParams {
  name: EvalRunnerName;
  binary: string;
  /** Environment passed to `checkRunnerBinary`; defaults to `env`. */
  preflightEnv?: Environment;
  /** Environment passed to child processes. */
  env: Environment;
  sandboxSupported: boolean;
  buildTaskArgs: (request: RunnerTaskRequest) => readonly string[];
  parseTaskStream: (params: {
    stdout: string;
    skillName: string;
    fallbackDurationMs: number;
  }) => ParsedTaskStream;
  buildGraderArgs: (request: RunnerGraderRequest) => readonly string[];
  parseGraderOutput: (params: {
    stdout: string;
    fallbackDurationMs: number;
  }) => ParsedGraderOutput;
  graderRetries?: number;
  graderRetryDelayMs?: number;
}

/**
 * Creates a CLI-backed `EvalRunner` adapter (`agy`, `claude`, `codex`, `gemini`)
 * with shared preflight, task execution, and grader execution (including
 * optional grader retries with isolated log prefixes and cleaned workdirs).
 */
export function createCliRunner({
  name,
  binary,
  preflightEnv,
  env,
  sandboxSupported,
  buildTaskArgs,
  parseTaskStream,
  buildGraderArgs,
  parseGraderOutput,
  graderRetries = 0,
  graderRetryDelayMs = 1000,
}: CreateCliRunnerParams): EvalRunner {
  return {
    name,
    sandboxSupported,
    async preflight(): Promise<void> {
      await checkRunnerBinary({ binary, env: preflightEnv ?? env });
    },

    // Task runs are never retried: a failed attempt may have modified the
    // workdir, so a rerun would not start from the fixture state.
    async runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult> {
      const { workdir, runDir, skillName, timeoutSeconds } = request;
      const proc = await spawnRunnerProcess({
        binary,
        args: buildTaskArgs(request),
        cwd: workdir,
        runDir,
        timeoutSeconds,
        env,
      });
      const parsed = parseTaskStream({
        stdout: proc.stdout,
        skillName,
        fallbackDurationMs: proc.durationMs,
      });
      return buildTaskResult({
        label: name,
        proc,
        parsed,
        timeoutSeconds,
      });
    },

    async runGrader(request: RunnerGraderRequest): Promise<RunnerGraderResult> {
      const { workdir, runDir, timeoutSeconds } = request;
      const args = buildGraderArgs(request);
      let lastError: unknown;
      for (let attempt = 0; attempt <= graderRetries; attempt += 1) {
        if (attempt > 0) {
          if (graderRetryDelayMs > 0) {
            await delay(graderRetryDelayMs * attempt);
          }
          await rm(workdir, { recursive: true, force: true });
          await mkdir(workdir, { recursive: true });
        }
        try {
          const proc = await spawnRunnerProcess({
            binary,
            args,
            cwd: workdir,
            runDir,
            timeoutSeconds,
            env,
            logPrefix: attempt === 0 ? 'grader' : `grader-retry-${attempt}`,
          });
          return parseGraderProcess({
            label: `${name} grader`,
            proc,
            timeoutSeconds,
            parse: () =>
              parseGraderOutput({
                stdout: proc.stdout,
                fallbackDurationMs: proc.durationMs,
              }),
          });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    },
  };
}
