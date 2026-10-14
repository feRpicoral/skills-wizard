import type { Environment } from '../../env.ts';
import { RunnerError } from '../../errors.ts';
import {
  createCliRunner,
  type EvalRunner,
  isRecordObject,
  isUsageReported,
  mentionsSkillFile,
  normalizeUsage,
  type ParsedGraderOutput,
  type ParsedTaskStream,
  parseJsonDocument,
  parseJsonLines,
} from './types.ts';

export interface BuildClaudeTaskArgsParams {
  prompt: string;
  skillName: string;
  excludeSkill?: boolean;
}

/**
 * `--disallowedTools` is variadic, and prompts may start with `-`, so the
 * prompt always follows `--`.
 */
export function buildClaudeTaskArgs({
  prompt,
  skillName,
  excludeSkill = false,
}: BuildClaudeTaskArgsParams): string[] {
  return [
    '-p',
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(excludeSkill ? ['--disallowedTools', `Skill(${skillName})`] : []),
    '--',
    prompt,
  ];
}

export interface BuildClaudeGraderArgsParams {
  prompt: string;
  schema: Record<string, unknown>;
}

/**
 * The grader gets no built-in tools (`--tools ""`), no MCP tools
 * (`--disallowedTools=mcp__*`) and `dontAsk`, which denies any tool call that
 * would need approval. Everything it needs is in the prompt.
 *
 * `--json-schema` still works: `--tools` only restricts built-in tools, and
 * the structured-output tool it synthesizes is not one of them (the
 * documented `--tools ""` + `--json-schema` combination is the known-good
 * headless setup). `--disallowedTools "*"` is avoided because it removes
 * every tool, including that one.
 */
export function buildClaudeGraderArgs({
  prompt,
  schema,
}: BuildClaudeGraderArgsParams): string[] {
  return [
    '-p',
    '--tools',
    '',
    '--disallowedTools=mcp__*',
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--',
    prompt,
  ];
}

export interface ParseClaudeStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export type ParsedClaudeStream = ParsedTaskStream;

interface ClaudeToolUseTriggerParams {
  block: Record<string, unknown>;
  skillName: string;
}

function isClaudeToolUseTrigger({
  block,
  skillName,
}: ClaudeToolUseTriggerParams): boolean {
  if (block.type !== 'tool_use') return false;
  const name = block.name;
  const input = isRecordObject(block.input) ? block.input : undefined;
  if (!input) return false;

  if (name === 'Skill') {
    const skill =
      typeof input.skill === 'string'
        ? input.skill
        : typeof input.command === 'string'
          ? input.command
          : undefined;
    return (
      skill !== undefined &&
      (skill === skillName || skill.endsWith(`:${skillName}`))
    );
  }
  if (name === 'Read' && typeof input.file_path === 'string') {
    return mentionsSkillFile(input.file_path, skillName);
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    return mentionsSkillFile(input.command, skillName);
  }
  return false;
}

/**
 * The error a Claude `result` message reports: `is_error: true` or an
 * `error_*` subtype (`error_max_turns`, `error_during_execution`, ...).
 */
export function claudeResultError(
  event: Record<string, unknown>,
): string | undefined {
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  const isError = event.is_error === true || subtype.startsWith('error');
  if (!isError) return undefined;
  const details = Array.isArray(event.errors)
    ? event.errors.filter((item): item is string => typeof item === 'string')
    : [];
  const message =
    details.length > 0
      ? details.join('; ')
      : typeof event.result === 'string' && event.result.length > 0
        ? event.result
        : undefined;
  const label = subtype || 'error';
  return message ? `${label}: ${message}` : label;
}

export function parseClaudeStreamJson({
  stdout,
  skillName,
  fallbackDurationMs = 0,
}: ParseClaudeStreamParams): ParsedClaudeStream {
  const events = parseJsonLines(stdout);
  let triggered = false;
  let response = '';
  let durationMs = fallbackDurationMs;
  let usage = normalizeUsage(undefined);
  let usageReported = false;
  let sawResult = false;
  let error: string | undefined;

  for (const event of events) {
    if (event.type === 'assistant' && isRecordObject(event.message)) {
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            isRecordObject(block) &&
            isClaudeToolUseTrigger({ block, skillName })
          ) {
            triggered = true;
          }
        }
      }
    }
    if (event.type === 'result') {
      sawResult = true;
      response = typeof event.result === 'string' ? event.result : '';
      if (typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      usage = normalizeUsage(event.usage);
      usageReported = isUsageReported(event.usage);
      error = claudeResultError(event);
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

export interface ParseClaudeGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export function parseClaudeGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseClaudeGraderParams): ParsedGraderOutput {
  const doc = parseJsonDocument(stdout);
  const durationMs =
    typeof doc.duration_ms === 'number' ? doc.duration_ms : fallbackDurationMs;
  const usage = normalizeUsage(doc.usage);

  const error = claudeResultError(doc);
  if (error !== undefined) {
    throw new RunnerError(`claude grader failed: ${error}`);
  }
  // With `--json-schema`, a `success` result without `structured_output` is
  // a failure (Agent SDK structured outputs docs), not text to parse.
  if (doc.structured_output === undefined || doc.structured_output === null) {
    throw new RunnerError(
      'claude grader result contained no structured_output',
    );
  }
  return {
    output: doc.structured_output,
    durationMs,
    usage,
  };
}

export interface CreateClaudeRunnerParams {
  binary?: string;
  env: Environment;
}

export function createClaudeRunner({
  binary,
  env,
}: CreateClaudeRunnerParams): EvalRunner {
  return createCliRunner({
    name: 'claude',
    binary: binary ?? 'claude',
    env,
    // Claude Code has no sandbox flag; `--sandbox` cannot be honored.
    sandboxSupported: false,
    buildTaskArgs: ({ prompt, skillName, excludeSkill }) =>
      buildClaudeTaskArgs({ prompt, skillName, excludeSkill }),
    parseTaskStream: ({ stdout, skillName, fallbackDurationMs }) =>
      parseClaudeStreamJson({ stdout, skillName, fallbackDurationMs }),
    buildGraderArgs: ({ prompt, schema }) =>
      buildClaudeGraderArgs({ prompt, schema }),
    parseGraderOutput: ({ stdout, fallbackDurationMs }) =>
      parseClaudeGraderJson({ stdout, fallbackDurationMs }),
  });
}
