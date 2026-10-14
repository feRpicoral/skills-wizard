import type { AgyConfig, Environment } from '../../env.ts';
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
  parseJsonDocument,
  parseJsonLines,
} from './types.ts';

export interface BuildAgyTaskArgsParams {
  prompt: string;
  timeoutSeconds: number;
  sandbox?: boolean;
  extraArgs?: readonly string[];
}

export function buildAgyTaskArgs({
  prompt,
  timeoutSeconds,
  sandbox = false,
  extraArgs = [],
}: BuildAgyTaskArgsParams): string[] {
  return [
    '--dangerously-skip-permissions',
    `--print-timeout=${timeoutSeconds}s`,
    '--output-format=stream-json',
    ...(sandbox ? ['--sandbox'] : []),
    ...extraArgs,
    `-p=${prompt}`,
  ];
}

export interface BuildAgyGraderArgsParams {
  prompt: string;
  schemaPath: string;
  timeoutSeconds: number;
  extraArgs?: readonly string[];
}

/**
 * The grader runs without `--dangerously-skip-permissions`, so headless agy
 * soft-denies every tool call that needs approval, and with `--sandbox`.
 */
export function buildAgyGraderArgs({
  prompt,
  schemaPath,
  timeoutSeconds,
  extraArgs = [],
}: BuildAgyGraderArgsParams): string[] {
  return [
    `--print-timeout=${timeoutSeconds}s`,
    '--output-format=json',
    `--json-schema=${schemaPath}`,
    '--sandbox',
    ...extraArgs,
    `-p=${prompt}`,
  ];
}

export interface ParseAgyStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export type ParsedAgyStream = ParsedTaskStream;

interface AgySkillTriggerStepParams {
  event: Record<string, unknown>;
  skillName: string;
}

/**
 * The payload of a `name` event, either nested under `event.name` (with
 * `event.event === name`) or flat (with `event.type === name`).
 */
function agyEventPayload(
  event: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const nested = event[name];
  if (event.event === name && isRecordObject(nested)) return nested;
  if (event.type === name) return event;
  return undefined;
}

function agyFilePath(params: Record<string, unknown>): string | undefined {
  if (typeof params.AbsolutePath === 'string') return params.AbsolutePath;
  if (typeof params.Path === 'string') return params.Path;
  return undefined;
}

function agyDurationMs(payload: Record<string, unknown>): number | undefined {
  if (typeof payload.duration_ms === 'number') return payload.duration_ms;
  if (typeof payload.duration_seconds === 'number') {
    return Math.round(payload.duration_seconds * 1000);
  }
  return undefined;
}

function isAgySkillTriggerStep({
  event,
  skillName,
}: AgySkillTriggerStepParams): boolean {
  const stepUpdate = agyEventPayload(event, 'step_update');

  if (!stepUpdate) return false;

  const toolName = stepUpdate.tool_name;
  const toolInfo = isRecordObject(stepUpdate.tool_info)
    ? stepUpdate.tool_info
    : undefined;
  const params =
    toolInfo && isRecordObject(toolInfo.parameters)
      ? toolInfo.parameters
      : undefined;

  if (!params) return false;

  const filePath = agyFilePath(params);

  if (
    (toolName === 'view_file' || toolName === 'read_file') &&
    filePath !== undefined
  ) {
    return mentionsSkillFile(filePath, skillName);
  }

  if (toolName === 'run_command' && typeof params.CommandLine === 'string') {
    return mentionsSkillFile(params.CommandLine, skillName);
  }

  return false;
}

/** Result statuses that mean the run did not finish successfully. */
const AGY_FAILED_STATUSES = new Set([
  'ERROR',
  'CANCELED',
  'INTERRUPTED',
  'INVALID',
]);

function agyResultError(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.error === 'string' && payload.error.length > 0) {
    return payload.error;
  }

  if (
    typeof payload.status === 'string' &&
    AGY_FAILED_STATUSES.has(payload.status)
  ) {
    return `status ${payload.status}`;
  }

  return undefined;
}

export function parseAgyStreamJson({
  stdout,
  skillName,
  fallbackDurationMs = 0,
}: ParseAgyStreamParams): ParsedAgyStream {
  const events = parseJsonLines(stdout);
  let triggered = false;
  let response = '';
  let durationMs = fallbackDurationMs;
  let usage = normalizeUsage(undefined);
  let usageReported = false;
  let sawResult = false;
  let error: string | undefined;

  for (const event of events) {
    if (isAgySkillTriggerStep({ event, skillName })) {
      triggered = true;
    }

    const resultPayload = agyEventPayload(event, 'result');

    if (resultPayload) {
      sawResult = true;
      error = agyResultError(resultPayload);
      if (typeof resultPayload.response === 'string') {
        response = resultPayload.response;
      }

      durationMs = agyDurationMs(resultPayload) ?? durationMs;
      usage = normalizeUsage(resultPayload.usage);
      usageReported = isUsageReported(resultPayload.usage);
    }
  }

  return {
    response,
    triggered,
    durationMs,
    usage,
    usageReported,
    sawResult,
    ...(error !== undefined ? { error } : {}),
  };
}

export interface ParseAgyGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export type ParsedAgyGrader = ParsedGraderOutput;

export function parseAgyGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseAgyGraderParams): ParsedGraderOutput {
  const doc = parseJsonDocument(stdout);
  const durationMs = agyDurationMs(doc) ?? fallbackDurationMs;
  const usage = normalizeUsage(doc.usage);

  const error = agyResultError(doc);

  if (error !== undefined) {
    throw new RunnerError(`agy grader failed: ${error}`);
  }

  if (doc.structured_output !== undefined) {
    return {
      output: doc.structured_output,
      durationMs,
      usage,
    };
  }

  if (typeof doc.response === 'string') {
    return {
      output: extractJsonFromText(doc.response),
      durationMs,
      usage,
    };
  }

  throw new RunnerError(
    'agy grader output contained neither structured_output nor response',
  );
}

export interface CreateAgyRunnerParams {
  binary?: string;
  agyConfig?: AgyConfig;
  env: Environment;
  /** Delay before each grader retry; tests pass 0. */
  graderRetryDelayMs?: number;
}

const GRADER_RETRIES = 2;

export function createAgyRunner({
  binary,
  agyConfig,
  env,
  graderRetryDelayMs = 1000,
}: CreateAgyRunnerParams): EvalRunner {
  const resolvedBin = binary ?? agyConfig?.bin ?? 'agy';
  const extraArgs = agyConfig?.extraArgs ?? [];

  return createCliRunner({
    name: 'agy',
    binary: resolvedBin,
    env,
    sandboxSupported: true,
    buildTaskArgs: ({ prompt, timeoutSeconds, sandbox }) =>
      buildAgyTaskArgs({ prompt, timeoutSeconds, sandbox, extraArgs }),
    parseTaskStream: ({ stdout, skillName, fallbackDurationMs }) =>
      parseAgyStreamJson({ stdout, skillName, fallbackDurationMs }),
    buildGraderArgs: ({ prompt, schemaPath, timeoutSeconds }) =>
      buildAgyGraderArgs({ prompt, schemaPath, timeoutSeconds, extraArgs }),
    parseGraderOutput: ({ stdout, fallbackDurationMs }) =>
      parseAgyGraderJson({ stdout, fallbackDurationMs }),
    graderRetries: GRADER_RETRIES,
    graderRetryDelayMs,
  });
}
