import type { Environment } from '../../env.ts';
import { RunnerError } from '../../errors.ts';
import {
  createCliRunner,
  type EvalRunner,
  extractJsonFromText,
  isRecordObject,
  isUsageReported,
  mentionsSkillFile,
  normalizeUsage,
  type ParsedGraderOutput,
  type ParsedTaskStream,
  parseJsonLines,
} from './types.ts';

/**
 * Task runs always use `--sandbox workspace-write`: writes are confined to the
 * workspace and temp dirs. `--` keeps prompts that start with `-` or match a
 * subcommand name (`resume`, `review`, `help`) positional.
 */
export function buildCodexTaskArgs(prompt: string): string[] {
  return [
    'exec',
    '--sandbox',
    'workspace-write',
    '--ephemeral',
    '--json',
    '--',
    prompt,
  ];
}

export interface BuildCodexGraderArgsParams {
  prompt: string;
  schemaPath: string;
}

/**
 * The grader runs read-only in an empty directory that is not a git
 * repository, hence `--skip-git-repo-check`.
 */
export function buildCodexGraderArgs({
  prompt,
  schemaPath,
}: BuildCodexGraderArgsParams): string[] {
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--output-schema',
    schemaPath,
    '--',
    prompt,
  ];
}

export interface ParseCodexStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export type ParsedCodexStream = ParsedTaskStream;

function codexErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecordObject(value) && typeof value.message === 'string') {
    return value.message;
  }
  return undefined;
}

export function parseCodexStreamJson({
  stdout,
  skillName,
  fallbackDurationMs = 0,
}: ParseCodexStreamParams): ParsedCodexStream {
  const events = parseJsonLines(stdout);
  let triggered = false;
  let response = '';
  let usage = normalizeUsage(undefined);
  let usageReported = false;
  let sawResult = false;
  let turnCompleted = false;
  let turnError: string | undefined;
  let streamError: string | undefined;

  for (const event of events) {
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      isRecordObject(event.item)
    ) {
      const item = event.item;

      if (
        item.type === 'command_execution' &&
        typeof item.command === 'string' &&
        mentionsSkillFile(item.command, skillName)
      ) {
        triggered = true;
      }

      if (
        event.type === 'item.completed' &&
        item.type === 'agent_message' &&
        typeof item.text === 'string'
      ) {
        response = item.text;
      }
    }

    if (event.type === 'turn.completed') {
      sawResult = true;
      turnCompleted = true;
      // `cached_input_tokens` is a subset of `input_tokens`.
      usage = normalizeUsage(event.usage);
      usageReported = isUsageReported(event.usage);
    }

    if (event.type === 'turn.failed') {
      sawResult = true;
      turnError = codexErrorMessage(event.error) ?? 'turn failed';
    }

    if (event.type === 'error') {
      streamError = codexErrorMessage(event.message) ?? 'stream error';
    }
  }

  // A top-level `error` event only fails the run when no turn completed.
  const error = turnError ?? (turnCompleted ? undefined : streamError);

  return {
    response,
    triggered,
    durationMs: fallbackDurationMs,
    usage,
    usageReported,
    sawResult,
    ...(error !== undefined ? { error } : {}),
  };
}

export interface ParseCodexGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export function parseCodexGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseCodexGraderParams): ParsedGraderOutput {
  const stream = parseCodexStreamJson({
    stdout,
    skillName: '',
    fallbackDurationMs,
  });

  if (stream.error !== undefined) {
    throw new RunnerError(`codex grader failed: ${stream.error}`);
  }

  if (!stream.sawResult) {
    throw new RunnerError(
      'codex grader output ended without a turn.completed event',
    );
  }

  if (!stream.response) {
    throw new RunnerError('codex grader returned no agent message');
  }

  return {
    output: extractJsonFromText(stream.response),
    durationMs: stream.durationMs,
    usage: stream.usage,
  };
}

export interface CreateCodexRunnerParams {
  binary?: string;
  env: Environment;
}

export function createCodexRunner({
  binary,
  env,
}: CreateCodexRunnerParams): EvalRunner {
  return createCliRunner({
    name: 'codex',
    binary: binary ?? 'codex',
    env,
    // Task runs are always confined by `--sandbox workspace-write`.
    sandboxSupported: true,
    buildTaskArgs: ({ prompt }) => buildCodexTaskArgs(prompt),
    parseTaskStream: ({ stdout, skillName, fallbackDurationMs }) =>
      parseCodexStreamJson({ stdout, skillName, fallbackDurationMs }),
    buildGraderArgs: ({ prompt, schemaPath }) =>
      buildCodexGraderArgs({ prompt, schemaPath }),
    parseGraderOutput: ({ stdout, fallbackDurationMs }) =>
      parseCodexGraderJson({ stdout, fallbackDurationMs }),
  });
}
