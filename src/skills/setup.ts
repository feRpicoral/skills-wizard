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
  deferSignal?: boolean;
}

interface SetupFailure extends Error {
  stderr: string;
  signal?: NodeJS.Signals;
}

function setupFailure(
  message: string,
  stderr: string,
  signal?: NodeJS.Signals,
): SetupFailure {
  return Object.assign(new Error(message), {
    stderr,
    ...(signal ? { signal } : {}),
  });
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
// this process is interrupted. The group gets SIGTERM because a non-interactive
// shell's background jobs ignore SIGINT.
function forwardSignals(
  pid: number | undefined,
  onSignal: (signal: NodeJS.Signals) => void,
): () => void {
  function stop(): void {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  }

  function forward(signal: NodeJS.Signals): void {
    onSignal(signal);
    killGroup(pid, 'SIGTERM');
  }

  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);

  return stop;
}

interface ExecuteSetupParams {
  dir: string;
  command: string;
  timeoutMs: number;
  deferSignal: boolean;
}

function execute({
  dir,
  command,
  timeoutMs,
  deferSignal,
}: ExecuteSetupParams): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL, ['-c', command], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });

    let interruptedBy: NodeJS.Signals | undefined;
    const stopForwarding = forwardSignals(child.pid, (signal) => {
      interruptedBy ??= signal;
    });

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

      if (interruptedBy !== undefined && !deferSignal) {
        process.kill(process.pid, interruptedBy);
        return;
      }

      if (interruptedBy !== undefined) {
        reject(
          setupFailure(`stopped by ${interruptedBy}`, stderr, interruptedBy),
        );
      } else if (timedOut) {
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
  deferSignal = false,
}: RunSetupParams): Promise<void> {
  try {
    await execute({ dir, command, timeoutMs, deferSignal });
  } catch (error) {
    const signal =
      error instanceof Error &&
      'signal' in error &&
      typeof error.signal === 'string'
        ? (error.signal as NodeJS.Signals)
        : undefined;

    throw new SetupError(`"${command}" failed: ${failureDetail(error)}`, {
      cause: error,
      ...(signal ? { signal } : {}),
    });
  }
}
