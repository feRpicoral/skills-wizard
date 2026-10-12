import type { Environment } from '../../env.ts';
import { RunnerError } from '../../errors.ts';
import {
  type EvalRunner,
  extractJsonFromText,
  normalizeUsage,
  parseJsonDocument,
  parseJsonLines,
  type RunnerGraderRequest,
  type RunnerGraderResult,
  type RunnerTaskRequest,
  type RunnerTaskResult,
  type RunnerUsage,
  spawnRunnerProcess,
} from './types.ts';

export interface BuildClaudeTaskArgsParams {
  prompt: string;
  skillName: string;
  excludeSkill?: boolean;
}

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
    prompt,
  ];
}

export interface BuildClaudeGraderArgsParams {
  prompt: string;
  schema: Record<string, unknown>;
}

export function buildClaudeGraderArgs({
  prompt,
  schema,
}: BuildClaudeGraderArgsParams): string[] {
  return [
    '-p',
    '--dangerously-skip-permissions',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    prompt,
  ];
}

export interface ParseClaudeStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export interface ParsedClaudeStream {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
}

function isClaudeToolUseTrigger(
  block: Record<string, unknown>,
  skillName: string,
): boolean {
  if (block.type !== 'tool_use') return false;
  const name = block.name;
  const input =
    typeof block.input === 'object' && block.input !== null
      ? (block.input as Record<string, unknown>)
      : undefined;
  if (!input) return false;

  const targetSuffix = `/${skillName}/SKILL.md`;
  const targetSubstr = `${skillName}/SKILL.md`;

  if (name === 'Skill' && typeof input.skill === 'string') {
    return input.skill === skillName || input.skill.endsWith(`:${skillName}`);
  }
  if (name === 'Read' && typeof input.file_path === 'string') {
    const normalized = input.file_path.replaceAll('\\', '/');
    return normalized.endsWith(targetSuffix) || normalized === targetSubstr;
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    const normalized = input.command.replaceAll('\\', '/');
    return normalized.includes(targetSubstr);
  }
  return false;
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

  for (const event of events) {
    if (
      event.type === 'assistant' &&
      typeof event.message === 'object' &&
      event.message !== null
    ) {
      const msg = event.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (typeof item === 'object' && item !== null) {
            if (
              isClaudeToolUseTrigger(item as Record<string, unknown>, skillName)
            ) {
              triggered = true;
            }
          }
        }
      }
    }
    if (event.type === 'result') {
      if (typeof event.result === 'string') {
        response = event.result;
      } else if (typeof event.response === 'string') {
        response = event.response;
      }
      if (typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      usage = normalizeUsage(event.usage);
    }
  }

  return {
    response,
    triggered,
    durationMs,
    usage,
  };
}

export interface ParseClaudeGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export function parseClaudeGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseClaudeGraderParams): {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
} {
  const doc = parseJsonDocument(stdout);
  const durationMs =
    typeof doc.duration_ms === 'number' ? doc.duration_ms : fallbackDurationMs;
  const usage = normalizeUsage(doc.usage);

  if (doc.structured_output !== undefined) {
    return {
      output: doc.structured_output,
      durationMs,
      usage,
    };
  }
  if (typeof doc.result === 'string') {
    return {
      output: extractJsonFromText(doc.result),
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
    'claude grader output contained neither structured_output nor result',
  );
}

export interface CreateClaudeRunnerParams {
  binary?: string;
  env?: Environment;
}

export function createClaudeRunner({
  binary,
  env,
}: CreateClaudeRunnerParams = {}): EvalRunner {
  const resolvedBin = binary ?? 'claude';

  return {
    name: 'claude',
    async runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult> {
      const args = buildClaudeTaskArgs({
        prompt: request.prompt,
        skillName: request.skillName,
        excludeSkill: request.excludeSkill,
      });
      const proc = await spawnRunnerProcess({
        binary: resolvedBin,
        args,
        cwd: request.workdir,
        runDir: request.runDir,
        timeoutSeconds: request.timeoutSeconds,
        env,
      });
      const parsed = parseClaudeStreamJson({
        stdout: proc.stdout,
        skillName: request.skillName,
        fallbackDurationMs: proc.durationMs,
      });
      return {
        response: parsed.response,
        triggered: parsed.triggered,
        durationMs: parsed.durationMs,
        usage: parsed.usage,
        exitCode: proc.exitCode,
        timedOut: proc.timedOut,
        rawStdout: proc.stdout,
        rawStderr: proc.stderr,
      };
    },

    async runGrader(request: RunnerGraderRequest): Promise<RunnerGraderResult> {
      const args = buildClaudeGraderArgs({
        prompt: request.prompt,
        schema: request.schema,
      });
      const proc = await spawnRunnerProcess({
        binary: resolvedBin,
        args,
        cwd: request.workdir,
        runDir: request.runDir,
        timeoutSeconds: request.timeoutSeconds,
        env,
        logPrefix: 'grader',
      });
      const parsed = parseClaudeGraderJson({
        stdout: proc.stdout,
        fallbackDurationMs: proc.durationMs,
      });
      return {
        output: parsed.output,
        durationMs: parsed.durationMs,
        usage: parsed.usage,
        rawStdout: proc.stdout,
        rawStderr: proc.stderr,
      };
    },
  };
}
