import { join } from 'node:path';

import type { AgyConfig, Environment } from '../../env.ts';
import { UsageError } from '../../errors.ts';
import { lstatIfExists } from '../../install/fs.ts';
import { createAgyRunner } from './agy.ts';
import { createClaudeRunner } from './claude.ts';
import { createCodexRunner } from './codex.ts';
import { createFakeRunner, type FakeRunnerOptions } from './fake.ts';
import { createGeminiRunner } from './gemini.ts';
import type { EvalRunner, EvalRunnerName } from './types.ts';

export const EVAL_RUNNER_NAMES: readonly EvalRunnerName[] = [
  'agy',
  'claude',
  'codex',
  'gemini',
  'fake',
];

const AUTO_DETECT_ORDER: readonly EvalRunnerName[] = [
  'agy',
  'claude',
  'codex',
  'gemini',
];

export function isEvalRunnerName(value: string): value is EvalRunnerName {
  return (EVAL_RUNNER_NAMES as readonly string[]).includes(value);
}

export function parseEvalRunnerName(value: string): EvalRunnerName {
  if (!isEvalRunnerName(value)) {
    throw new UsageError(
      `Unknown eval runner "${value}". Expected one of: ${EVAL_RUNNER_NAMES.join(', ')}`,
    );
  }
  return value;
}

async function isExecutableOnPath(
  name: string,
  searchPath: readonly string[],
): Promise<boolean> {
  for (const dir of searchPath) {
    const candidate = join(dir, name);
    const info = await lstatIfExists(candidate);
    if (info && !info.isDirectory()) {
      return true;
    }
  }
  return false;
}

export interface DetectDefaultRunnerParams {
  searchPath: readonly string[];
  agyConfig?: AgyConfig;
}

export async function detectDefaultRunner({
  searchPath,
  agyConfig,
}: DetectDefaultRunnerParams): Promise<EvalRunnerName> {
  if (agyConfig?.bin) {
    const info = await lstatIfExists(agyConfig.bin);
    if (info && !info.isDirectory()) {
      return 'agy';
    }
  }
  for (const candidate of AUTO_DETECT_ORDER) {
    if (await isExecutableOnPath(candidate, searchPath)) {
      return candidate;
    }
  }
  return 'agy';
}

export interface CreateEvalRunnerParams {
  runner: EvalRunnerName;
  binary?: string;
  agyConfig?: AgyConfig;
  env?: Environment;
  fakeOptions?: FakeRunnerOptions;
}

export function createEvalRunner({
  runner,
  binary,
  agyConfig,
  env,
  fakeOptions,
}: CreateEvalRunnerParams): EvalRunner {
  switch (runner) {
    case 'agy':
      return createAgyRunner({ binary, agyConfig, env });
    case 'claude':
      return createClaudeRunner({ binary, env });
    case 'codex':
      return createCodexRunner({ binary, env });
    case 'gemini':
      return createGeminiRunner({ binary, env });
    case 'fake':
      return createFakeRunner(fakeOptions);
  }
}

export {
  buildAgyGraderArgs,
  buildAgyTaskArgs,
  parseAgyGraderJson,
  parseAgyStreamJson,
} from './agy.ts';
export {
  buildClaudeGraderArgs,
  buildClaudeTaskArgs,
  parseClaudeGraderJson,
  parseClaudeStreamJson,
} from './claude.ts';
export {
  buildCodexGraderArgs,
  buildCodexTaskArgs,
  parseCodexGraderJson,
  parseCodexStreamJson,
} from './codex.ts';
export { createFakeRunner, type FakeRunnerOptions } from './fake.ts';
export {
  buildGeminiGraderArgs,
  buildGeminiTaskArgs,
  parseGeminiGraderJson,
  parseGeminiStreamJson,
} from './gemini.ts';
export type {
  EvalRunner,
  EvalRunnerName,
  RunnerGraderRequest,
  RunnerGraderResult,
  RunnerTaskRequest,
  RunnerTaskResult,
  RunnerUsage,
} from './types.ts';
