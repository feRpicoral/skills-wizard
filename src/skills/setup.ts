import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SetupError } from '../errors.ts';
import { failureDetail } from './process.ts';

const run = promisify(execFile);

const SHELL = '/bin/sh';
const SETUP_TIMEOUT_MS = 10 * 60_000;

export interface RunSetupParams {
  dir: string;
  command: string;
}

export async function runSetup({
  dir,
  command,
}: RunSetupParams): Promise<void> {
  try {
    await run(SHELL, ['-c', command], { cwd: dir, timeout: SETUP_TIMEOUT_MS });
  } catch (error) {
    throw new SetupError(`"${command}" failed: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}
