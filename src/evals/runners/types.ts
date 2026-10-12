import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment } from '../../env.ts';
import { isSystemError, RunnerError } from '../../errors.ts';
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

export interface EvalRunner {
  readonly name: EvalRunnerName;
  runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult>;
  runGrader(request: RunnerGraderRequest): Promise<RunnerGraderResult>;
}

export interface SpawnRunnerProcessParams {
  binary: string;
  args: readonly string[];
  cwd: string;
  runDir: string;
  timeoutSeconds: number;
  env?: Environment;
  logPrefix?: string;
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

export function normalizeUsage(raw: unknown): RunnerUsage {
  if (typeof raw !== 'object' || raw === null) {
    return emptyUsage();
  }
  const record = raw as Record<string, unknown>;
  const input =
    typeof record.input_tokens === 'number' ? record.input_tokens : 0;
  const output =
    typeof record.output_tokens === 'number' ? record.output_tokens : 0;
  const total =
    typeof record.total_tokens === 'number'
      ? record.total_tokens
      : input + output;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
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

export async function spawnRunnerProcess({
  binary,
  args,
  cwd,
  runDir,
  timeoutSeconds,
  env,
  logPrefix = '',
}: SpawnRunnerProcessParams): Promise<SpawnRunnerProcessResult> {
  await mkdir(runDir, { recursive: true });
  const startTime = Date.now();

  const result = await new Promise<SpawnRunnerProcessResult>(
    (resolve, reject) => {
      const child = spawn(binary, [...args], {
        cwd,
        env: env ? { ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 2_000);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (
          isSystemError(error) &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          reject(
            new RunnerError(`Runner binary "${binary}" was not found on PATH`, {
              cause: error,
            }),
          );
          return;
        }
        reject(
          new RunnerError(
            `Failed to launch runner "${binary}": ${error.message}`,
            { cause: error },
          ),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const durationMs = Math.max(1, Date.now() - startTime);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: code ?? (timedOut ? 124 : 1),
          timedOut,
          durationMs,
        });
      });
    },
  );

  const stdoutName = logPrefix ? `${logPrefix}-stdout.log` : 'stdout.log';
  const stderrName = logPrefix ? `${logPrefix}-stderr.log` : 'stderr.log';
  await writeFile(join(runDir, stdoutName), result.stdout);
  await writeFile(join(runDir, stderrName), result.stderr);

  return result;
}
