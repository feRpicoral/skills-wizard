import { spawn } from 'node:child_process';

import { SetupError } from '../errors.ts';
import { failureDetail } from './process.ts';

const SHELL = '/bin/sh';
const SETUP_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL_CHARS = 16 * 1024;

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

function execute({
  dir,
  command,
  timeoutMs,
}: Required<RunSetupParams>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL, ['-c', command], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      child.stderr.destroy();
    }, timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
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
