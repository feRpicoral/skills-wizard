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
  parseJsonDocument,
  parseJsonLines,
  type RunnerUsage,
} from './types.ts';

export interface BuildGeminiTaskArgsParams {
  prompt: string;
  sandbox?: boolean;
}

/** `--prompt=<text>` keeps prompts that start with `-` intact. */
export function buildGeminiTaskArgs({
  prompt,
  sandbox = false,
}: BuildGeminiTaskArgsParams): string[] {
  return [
    '--approval-mode=yolo',
    '--output-format=stream-json',
    ...(sandbox ? ['--sandbox'] : []),
    `--prompt=${prompt}`,
  ];
}

/**
 * The grader uses the `default` approval mode: in headless runs every tool
 * call that needs approval (shell, writes, edits) is denied.
 */
export function buildGeminiGraderArgs(prompt: string): string[] {
  return [
    '--approval-mode=default',
    '--output-format=json',
    `--prompt=${prompt}`,
  ];
}

/**
 * The child environment for every gemini run. With `security.folderTrust`
 * enabled, a headless run in an untrusted folder (every fresh eval workspace)
 * exits with FatalUntrustedWorkspaceError. The Gemini CLI trusted folders docs
 * document `GEMINI_CLI_TRUST_WORKSPACE=true` (what `--skip-trust` sets) to
 * trust the current workspace for one session. The variable is used rather
 * than the flag because older versions reject unknown flags but ignore an
 * unknown variable. Trust only lets the CLI load the workspace's own settings
 * (the baseline's `skills.disabled`); it does not change the approval mode.
 */
export function buildGeminiEnv(env: Environment): Environment {
  return { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
}

export interface ParseGeminiStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export type ParsedGeminiStream = ParsedTaskStream;

interface GeminiTriggerEventParams {
  event: Record<string, unknown>;
  skillName: string;
}

function isGeminiTriggerEvent({
  event,
  skillName,
}: GeminiTriggerEventParams): boolean {
  if (event.type !== 'tool_use') return false;

  const toolName = typeof event.tool_name === 'string' ? event.tool_name : '';
  const params = isRecordObject(event.parameters)
    ? event.parameters
    : undefined;
  if (!params) return false;

  if (toolName === 'activate_skill') {
    return params.name === skillName;
  }

  return Object.values(params).some(
    (value) => typeof value === 'string' && mentionsSkillFile(value, skillName),
  );
}

function geminiErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecordObject(value) && typeof value.message === 'string') {
    return value.message;
  }
  return undefined;
}

/**
 * Parses `--output-format stream-json`: the response is the concatenation of
 * assistant `message` events, and usage is in `result.stats`
 * (`input_tokens`, `output_tokens`, `total_tokens`, `duration_ms`).
 */
export function parseGeminiStreamJson({
  stdout,
  skillName,
  fallbackDurationMs = 0,
}: ParseGeminiStreamParams): ParsedGeminiStream {
  const events = parseJsonLines(stdout);
  let triggered = false;
  const assistantChunks: string[] = [];
  let durationMs = fallbackDurationMs;
  let usage = normalizeUsage(undefined);
  let usageReported = false;
  let sawResult = false;
  let error: string | undefined;

  for (const event of events) {
    if (isGeminiTriggerEvent({ event, skillName })) {
      triggered = true;
    }

    if (
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.content === 'string'
    ) {
      assistantChunks.push(event.content);
    }

    if (event.type === 'error' && event.severity === 'error') {
      error = geminiErrorMessage(event.message) ?? 'error event';
    }

    if (event.type === 'result') {
      sawResult = true;
      if (event.status === 'error') {
        error = geminiErrorMessage(event.error) ?? 'status error';
      }

      if (isRecordObject(event.stats)) {
        if (typeof event.stats.duration_ms === 'number') {
          durationMs = event.stats.duration_ms;
        }

        usage = normalizeUsage(event.stats);
        usageReported = isUsageReported(event.stats);
      }
    }
  }

  return {
    response: assistantChunks.join(''),
    triggered,
    durationMs,
    usage,
    usageReported,
    sawResult,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Sums `stats.models[*].tokens` from `--output-format json`. */
export function geminiJsonUsage(stats: unknown): RunnerUsage {
  const usage = normalizeUsage(undefined);

  if (!isRecordObject(stats) || !isRecordObject(stats.models)) return usage;

  for (const model of Object.values(stats.models)) {
    if (!isRecordObject(model) || !isRecordObject(model.tokens)) continue;

    const { prompt, candidates, total } = model.tokens;
    const input = typeof prompt === 'number' ? prompt : 0;
    const output = typeof candidates === 'number' ? candidates : 0;

    usage.input_tokens += input;
    usage.output_tokens += output;
    usage.total_tokens += typeof total === 'number' ? total : input + output;
  }

  return usage;
}

export interface ParseGeminiGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export function parseGeminiGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseGeminiGraderParams): ParsedGraderOutput {
  const doc = parseJsonDocument(stdout);
  const error = geminiErrorMessage(doc.error);

  if (error !== undefined) {
    throw new RunnerError(`gemini grader failed: ${error}`);
  }

  if (typeof doc.response !== 'string') {
    throw new RunnerError('gemini grader output contained no response');
  }

  return {
    output: extractJsonFromText(doc.response),
    durationMs: fallbackDurationMs,
    usage: geminiJsonUsage(doc.stats),
  };
}

export interface CreateGeminiRunnerParams {
  binary?: string;
  env: Environment;
}

export function createGeminiRunner({
  binary,
  env,
}: CreateGeminiRunnerParams): EvalRunner {
  return createCliRunner({
    name: 'gemini',
    binary: binary ?? 'gemini',
    preflightEnv: env,
    env: buildGeminiEnv(env),
    sandboxSupported: true,
    buildTaskArgs: ({ prompt, sandbox }) =>
      buildGeminiTaskArgs({ prompt, sandbox }),
    parseTaskStream: ({ stdout, skillName, fallbackDurationMs }) =>
      parseGeminiStreamJson({ stdout, skillName, fallbackDurationMs }),
    buildGraderArgs: ({ prompt }) => buildGeminiGraderArgs(prompt),
    parseGraderOutput: ({ stdout, fallbackDurationMs }) =>
      parseGeminiGraderJson({ stdout, fallbackDurationMs }),
  });
}
