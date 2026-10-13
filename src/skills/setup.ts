import { spawn } from 'node:child_process';

import { SetupError } from '../errors.ts';
import { failureDetail } from './process.ts';

const SHELL = '/bin/sh';
const SETUP_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL_CHARS = 16 * 1024;
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface RunSetupParams {
  dir: string;
  command: string;
  timeoutMs?: number;
}

interface SetupFailure extends Error {
  stderr: string;
}

function setupFailure(message: string, stderr: string): SetupFailure {
  return Object.assign(new Error(message), { stderr });
}

function isGone(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

// The command runs in its own process group so that everything it starts,
// including background jobs, can be stopped together.
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isGone(error)) throw error;
  }
}

// A detached group no longer receives the terminal's Ctrl+C, so stop it when
// this process is interrupted, then let the signal end this process as usual.
// The group gets SIGTERM because a non-interactive shell's background jobs
// ignore SIGINT.
function forwardSignals(pid: number | undefined): () => void {
  function stop(): void {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  }
  function forward(signal: NodeJS.Signals): void {
    killGroup(pid, 'SIGTERM');
    stop();
    process.kill(process.pid, signal);
  }
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  return stop;
}

function execute({
  dir,
  command,
  timeoutMs,
}: Required<RunSetupParams>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL, ['-c', command], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    const stopForwarding = forwardSignals(child.pid);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGKILL');
      child.stderr.destroy();
    }, timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      stopForwarding();
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      stopForwarding();
      if (timedOut) {
        reject(setupFailure(`timed out after ${timeoutMs / 1000} seconds`, ''));
      } else if (code === 0) {
        resolve();
      } else {
        const reason = signal
          ? `stopped by ${signal}`
          : `exited with code ${code}`;
        reject(setupFailure(reason, stderr));
      }
    });
  });
}

export async function runSetup({
  dir,
  command,
  timeoutMs = SETUP_TIMEOUT_MS,
}: RunSetupParams): Promise<void> {
  try {
    await execute({ dir, command, timeoutMs });
  } catch (error) {
    throw new SetupError(`"${command}" failed: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}
