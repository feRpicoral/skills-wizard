import { delimiter } from 'node:path';

import which from 'which';

import type { AgyConfig, Environment } from '../../env.ts';
import { UsageError } from '../../errors.ts';
import { lstatIfExists } from '../../install/fs.ts';
import { createAgyRunner } from './agy.ts';
import { createClaudeRunner } from './claude.ts';
import { createCodexRunner } from './codex.ts';
import { createFakeRunner, type FakeRunnerOptions } from './fake.ts';
import { createGeminiRunner } from './gemini.ts';
import {
  type EvalRunner,
  type EvalRunnerName,
  resolveRunnerBinary,
} from './types.ts';

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
  const path = searchPath.join(delimiter);
  if (!path) return 'agy';
  for (const candidate of AUTO_DETECT_ORDER) {
    if (await which(candidate, { path, nothrow: true })) {
      return candidate;
    }
  }
  return 'agy';
}

export interface CreateEvalRunnerParams {
  runner: EvalRunnerName;
  binary?: string;
  /**
   * Directory a relative `binary` path (one containing a slash, such as
   * `./bin/claude`) is resolved against, normally the CLI's cwd. Runners
   * spawn in per-run workdirs, so relative paths must be resolved up front.
   */
  cwd?: string;
  agyConfig?: AgyConfig;
  /** The complete environment for runner processes (never `process.env`). */
  env: Environment;
  fakeOptions?: FakeRunnerOptions;
}

export function createEvalRunner({
  runner,
  binary: rawBinary,
  cwd,
  agyConfig,
  env,
  fakeOptions,
}: CreateEvalRunnerParams): EvalRunner {
  const binary =
    rawBinary === undefined
      ? undefined
      : resolveRunnerBinary({ binary: rawBinary, cwd });
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
export {
  createFakeRunner,
  type FakeRunnerOptions,
  fakeTriggerDecision,
} from './fake.ts';
export {
  buildGeminiGraderArgs,
  buildGeminiTaskArgs,
  parseGeminiGraderJson,
  parseGeminiStreamJson,
} from './gemini.ts';
export type {
  EvalRunner,
  EvalRunnerName,
  ParsedGraderOutput,
  ParsedTaskStream,
  RunnerGraderRequest,
  RunnerGraderResult,
  RunnerTaskRequest,
  RunnerTaskResult,
  RunnerUsage,
} from './types.ts';
export {
  checkRunnerBinary,
  mentionsSkillFile,
  normalizeUsage,
  resolveRunnerBinary,
} from './types.ts';
