import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import which from 'which';

import type { Environment } from '../../env.ts';
import { isSystemError, RunnerError } from '../../errors.ts';
import { trackChildGroup } from '../children.ts';
import type { EvalRunnerName } from '../workspace.ts';

export type { EvalRunnerName };

export interface RunnerUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunnerTaskRequest {
  prompt: string;
  workdir: string;
  runDir: string;
  skillName: string;
  timeoutSeconds: number;
  sandbox?: boolean;
  excludeSkill?: boolean;
}

export interface RunnerTaskResult {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
  exitCode: number;
  timedOut: boolean;
  rawStdout: string;
  rawStderr: string;
  /** Why the run failed (timeout, non-zero exit, missing or error result). */
  error?: string;
  /** Whether the CLI reported token usage; defaults to `total_tokens > 0`. */
  usageReported?: boolean;
}

export interface RunnerGraderRequest {
  prompt: string;
  schemaPath: string;
  schema: Record<string, unknown>;
  workdir: string;
  runDir: string;
  timeoutSeconds: number;
}

export interface RunnerGraderResult {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
  rawStdout: string;
  rawStderr: string;
}

export interface ParsedGraderOutput {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
}

/** What a runner's stream parser extracts from a task run's stdout. */
export interface ParsedTaskStream {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
  usageReported: boolean;
  /** Whether the CLI emitted its final result event. */
  sawResult: boolean;
  /** Error reported by the CLI itself (error result or error event). */
  error?: string;
}

export interface EvalRunner {
  readonly name: EvalRunnerName;
  /**
   * Whether `RunnerTaskRequest.sandbox` is honored. When false, task runs
   * are not confined by the runner and callers should warn or refuse.
   */
  readonly sandboxSupported?: boolean;
  runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult>;
  runGrader(request: RunnerGraderRequest): Promise<RunnerGraderResult>;
  /** Fails fast (RunnerError) when the runner cannot start, e.g. a missing binary. */
  preflight?(): Promise<void>;
}

export interface SpawnRunnerProcessParams {
  binary: string;
  args: readonly string[];
  cwd: string;
  runDir: string;
  timeoutSeconds: number;
  /** The complete child environment; `process.env` is never inherited. */
  env: Environment;
  logPrefix?: string;
  /** Delay between SIGTERM and SIGKILL of the process group on timeout. */
  killGraceMs?: number;
  /** How long to wait for output to drain after the child exits or is killed. */
  drainMs?: number;
}

export interface SpawnRunnerProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

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

/** Whether a raw usage object carries at least one numeric token counter. */
export function isUsageReported(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return false;
  }
  return Object.entries(raw).some(
    ([key, value]) => key.endsWith('tokens') && typeof value === 'number',
  );
}

export function isRecordObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    `(?:^|[^A-Za-z0-9._-])skills/${escapeRegExp(skillName)}/SKILL\\.md(?![A-Za-z0-9._-])`,
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
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        events.push(parsed as Record<string, unknown>);
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
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
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

export interface CheckRunnerBinaryParams {
  binary: string;
  env: Environment;
}

/**
 * Resolves a runner binary the way `spawn` will (absolute path, or a command
 * name looked up on the child's PATH) and checks it is an executable file.
 */
export async function checkRunnerBinary({
  binary,
  env,
}: CheckRunnerBinaryParams): Promise<string> {
  if (binary.includes('/') || binary.includes('\\')) {
    if (!isAbsolute(binary)) {
      throw new RunnerError(
        `Runner binary "${binary}" must be an absolute path or a command name on PATH`,
      );
    }
    let info;
    try {
      info = await stat(binary);
      await access(binary, constants.X_OK);
    } catch (error) {
      throw new RunnerError(
        `Runner binary "${binary}" does not exist or is not executable`,
        { cause: error },
      );
    }
    if (!info.isFile()) {
      throw new RunnerError(`Runner binary "${binary}" is not a file`);
    }
    return binary;
  }
  const resolved = env.PATH
    ? await which(binary, {
        path: env.PATH,
        ...(env.PATHEXT !== undefined ? { pathExt: env.PATHEXT } : {}),
        nothrow: true,
      })
    : null;
  if (!resolved) {
    throw new RunnerError(
      `Runner binary "${binary}" was not found on PATH or is not executable`,
    );
  }
  return resolved;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_DRAIN_MS = 2_000;
const USE_PROCESS_GROUPS = process.platform !== 'win32';

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (USE_PROCESS_GROUPS) {
    try {
      // The child leads its own process group (detached), so this reaches
      // every descendant that did not start a new group.
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is already gone; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

function launchError(binary: string, error: Error): RunnerError {
  if (isSystemError(error) && 'code' in error && error.code === 'ENOENT') {
    return new RunnerError(`Runner binary "${binary}" was not found on PATH`, {
      cause: error,
    });
  }
  return new RunnerError(
    `Failed to launch runner "${binary}": ${error.message}`,
    { cause: error },
  );
}

/**
 * Runs a runner CLI in its own process group. On timeout the whole group gets
 * SIGTERM, then SIGKILL after `killGraceMs`. The result settles when the
 * output closes, or at most `drainMs` after the child exits or is killed, so
 * descendants holding stdout open cannot extend the run. Remaining group
 * members are killed when the result settles.
 */
export async function spawnRunnerProcess({
  binary,
  args,
  cwd,
  runDir,
  timeoutSeconds,
  env,
  logPrefix = '',
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  drainMs = DEFAULT_DRAIN_MS,
}: SpawnRunnerProcessParams): Promise<SpawnRunnerProcessResult> {
  await mkdir(runDir, { recursive: true });
  const startTime = Date.now();

  const result = await new Promise<SpawnRunnerProcessResult>(
    (resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, [...args], {
          cwd,
          env: { ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: USE_PROCESS_GROUPS,
        });
      } catch (error) {
        reject(
          launchError(
            binary,
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
        return;
      }
      // Stops the group if this process is interrupted while it runs.
      const untrack = trackChildGroup(child);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];
      let timedOut = false;
      let exitCode: number | null = null;
      let settled = false;

      const schedule = (ms: number, fn: () => void): void => {
        timers.push(setTimeout(fn, ms));
      };
      const clearTimers = (): void => {
        for (const timer of timers) clearTimeout(timer);
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        signalProcessTree(child, 'SIGKILL');
        untrack();
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: exitCode ?? (timedOut ? 124 : 1),
          timedOut,
          durationMs: Math.max(1, Date.now() - startTime),
        });
      };

      const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
      schedule(timeoutMs, () => {
        timedOut = true;
        signalProcessTree(child, 'SIGTERM');
        schedule(killGraceMs, () => {
          signalProcessTree(child, 'SIGKILL');
          schedule(drainMs, finish);
        });
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        signalProcessTree(child, 'SIGKILL');
        untrack();
        reject(launchError(binary, error));
      });

      child.on('exit', (code) => {
        exitCode = code;
        schedule(drainMs, finish);
      });

      child.on('close', finish);
    },
  );

  const stdoutName = logPrefix ? `${logPrefix}-stdout.log` : 'stdout.log';
  const stderrName = logPrefix ? `${logPrefix}-stderr.log` : 'stderr.log';
  await writeFile(join(runDir, stdoutName), result.stdout);
  await writeFile(join(runDir, stderrName), result.stderr);

  return result;
}
