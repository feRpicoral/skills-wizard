import type { Environment } from '../../env.ts';
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

export interface BuildGeminiTaskArgsParams {
  prompt: string;
  sandbox?: boolean;
}

export function buildGeminiTaskArgs({
  prompt,
  sandbox = false,
}: BuildGeminiTaskArgsParams): string[] {
  return [
    '--approval-mode=yolo',
    '--output-format',
    'stream-json',
    ...(sandbox ? ['--sandbox'] : []),
    '-p',
    prompt,
  ];
}

export function buildGeminiGraderArgs(prompt: string): string[] {
  return ['--approval-mode=yolo', '--output-format', 'json', '-p', prompt];
}

export interface ParseGeminiStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export interface ParsedGeminiStream {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
}

function isGeminiTriggerEvent(
  event: Record<string, unknown>,
  skillName: string,
): boolean {
  if (event.type !== 'tool_use') return false;
  const toolName =
    typeof event.tool_name === 'string'
      ? event.tool_name
      : typeof event.name === 'string'
        ? event.name
        : '';
  const params =
    typeof event.parameters === 'object' && event.parameters !== null
      ? (event.parameters as Record<string, unknown>)
      : typeof event.args === 'object' && event.args !== null
        ? (event.args as Record<string, unknown>)
        : undefined;
  if (!params) return false;

  if (
    toolName === 'activate_skill' &&
    (params.name === skillName || params.skill === skillName)
  ) {
    return true;
  }

  const targetSubstr = `${skillName}/SKILL.md`;
  for (const val of Object.values(params)) {
    if (
      typeof val === 'string' &&
      val.replaceAll('\\', '/').includes(targetSubstr)
    ) {
      return true;
    }
  }
  return false;
}

export function parseGeminiStreamJson({
  stdout,
  skillName,
  fallbackDurationMs = 0,
}: ParseGeminiStreamParams): ParsedGeminiStream {
  const events = parseJsonLines(stdout);
  let triggered = false;
  const assistantChunks: string[] = [];
  let finalResponse = '';
  let durationMs = fallbackDurationMs;
  let usage = normalizeUsage(undefined);

  for (const event of events) {
    if (isGeminiTriggerEvent(event, skillName)) {
      triggered = true;
    }
    if (
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.content === 'string'
    ) {
      assistantChunks.push(event.content);
    }
    if (event.type === 'result') {
      if (typeof event.response === 'string') {
        finalResponse = event.response;
      }
      if (typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      }
      if (event.usage !== undefined) {
        usage = normalizeUsage(event.usage);
      } else if (
        typeof event.stats === 'object' &&
        event.stats !== null &&
        'tokens' in event.stats
      ) {
        usage = normalizeUsage((event.stats as Record<string, unknown>).tokens);
      }
    }
  }

  return {
    response: finalResponse || assistantChunks.join(''),
    triggered,
    durationMs,
    usage,
  };
}

export interface ParseGeminiGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export function parseGeminiGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseGeminiGraderParams): {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
} {
  const doc = parseJsonDocument(stdout);
  const durationMs =
    typeof doc.duration_ms === 'number' ? doc.duration_ms : fallbackDurationMs;
  const usage = normalizeUsage(doc.usage);
  const responseText = typeof doc.response === 'string' ? doc.response : stdout;

  return {
    output: extractJsonFromText(responseText),
    durationMs,
    usage,
  };
}

export interface CreateGeminiRunnerParams {
  binary?: string;
  env?: Environment;
}

export function createGeminiRunner({
  binary,
  env,
}: CreateGeminiRunnerParams = {}): EvalRunner {
  const resolvedBin = binary ?? 'gemini';

  return {
    name: 'gemini',
    async runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult> {
      const args = buildGeminiTaskArgs({
        prompt: request.prompt,
        sandbox: request.sandbox,
      });
      const proc = await spawnRunnerProcess({
        binary: resolvedBin,
        args,
        cwd: request.workdir,
        runDir: request.runDir,
        timeoutSeconds: request.timeoutSeconds,
        env,
      });
      const parsed = parseGeminiStreamJson({
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
      const args = buildGeminiGraderArgs(request.prompt);
      const proc = await spawnRunnerProcess({
        binary: resolvedBin,
        args,
        cwd: request.workdir,
        runDir: request.runDir,
        timeoutSeconds: request.timeoutSeconds,
        env,
        logPrefix: 'grader',
      });
      const parsed = parseGeminiGraderJson({
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
