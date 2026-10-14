import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import which from 'which';

import type { Environment } from '../../env.ts';
import { isSystemError, RunnerError } from '../../errors.ts';
import { signalProcessTree, trackChildGroup } from '../children.ts';
import type {
  SpawnRunnerProcessParams,
  SpawnRunnerProcessResult,
} from './types.ts';

export { signalProcessTree };

export interface ResolveRunnerBinaryParams {
  binary: string;
  cwd?: string;
}

function isPathLike(binary: string): boolean {
  return binary.includes('/') || binary.includes('\\');
}

/**
 * Resolves a relative binary path that contains a slash (`./bin/claude`)
 * against `cwd`. Absolute paths and bare command names (looked up on PATH)
 * are returned unchanged.
 */
export function resolveRunnerBinary({
  binary,
  cwd,
}: ResolveRunnerBinaryParams): string {
  if (cwd === undefined || !isPathLike(binary) || isAbsolute(binary)) {
    return binary;
  }
  return resolve(cwd, binary);
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
  if (isPathLike(binary)) {
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
        pathExt: env.PATHEXT,
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

export function launchError(binary: string, error: Error): RunnerError {
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

export interface RunDetachedProcessParams {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: Environment;
  shell?: boolean;
  timeoutMs: number;
  killGraceMs?: number;
  drainMs?: number;
}

/**
 * Spawns a detached child process in its own process group, collects stdout and
 * stderr, and enforces `timeoutMs` (SIGTERM -> `killGraceMs` -> SIGKILL ->
 * `drainMs`).
 */
export function runDetachedProcess({
  command,
  args = [],
  cwd,
  env,
  shell = false,
  timeoutMs,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  drainMs = DEFAULT_DRAIN_MS,
}: RunDetachedProcessParams): Promise<SpawnRunnerProcessResult> {
  const startTime = Date.now();
  return new Promise<SpawnRunnerProcessResult>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd,
        env: { ...env },
        shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: USE_PROCESS_GROUPS,
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
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
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode: exitCode ?? (timedOut ? 124 : 1),
        timedOut,
        durationMs: Math.max(1, Date.now() - startTime),
      });
    };

    schedule(Math.max(1, Math.round(timeoutMs)), () => {
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
      reject(error);
    });

    child.on('exit', (code) => {
      exitCode = code;
      schedule(drainMs, finish);
    });

    child.on('close', finish);
  });
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

  let result: SpawnRunnerProcessResult;
  try {
    result = await runDetachedProcess({
      command: binary,
      args,
      cwd,
      env,
      timeoutMs: timeoutSeconds * 1000,
      killGraceMs,
      drainMs,
    });
  } catch (error) {
    throw launchError(
      binary,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  const stdoutName = logPrefix ? `${logPrefix}-stdout.log` : 'stdout.log';
  const stderrName = logPrefix ? `${logPrefix}-stderr.log` : 'stderr.log';
  await writeFile(join(runDir, stdoutName), result.stdout);
  await writeFile(join(runDir, stderrName), result.stderr);

  return result;
}
