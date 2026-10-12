import type { Environment } from '../../env.ts';
import {
  type EvalRunner,
  extractJsonFromText,
  normalizeUsage,
  parseJsonLines,
  type RunnerGraderRequest,
  type RunnerGraderResult,
  type RunnerTaskRequest,
  type RunnerTaskResult,
  type RunnerUsage,
  spawnRunnerProcess,
} from './types.ts';

export function buildCodexTaskArgs(prompt: string): string[] {
  return [
    'exec',
    '--sandbox',
    'workspace-write',
    '--ephemeral',
    '--json',
    prompt,
  ];
}

export interface BuildCodexGraderArgsParams {
  prompt: string;
  schemaPath: string;
}

export function buildCodexGraderArgs({
  prompt,
  schemaPath,
}: BuildCodexGraderArgsParams): string[] {
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--json',
    '--output-schema',
    schemaPath,
    prompt,
  ];
}

export interface ParseCodexStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export interface ParsedCodexStream {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
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
  const targetSubstr = `${skillName}/SKILL.md`;

  for (const event of events) {
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      typeof event.item === 'object' &&
      event.item !== null
    ) {
      const item = event.item as Record<string, unknown>;
      if (
        item.type === 'command_execution' &&
        typeof item.command === 'string' &&
        item.command.replaceAll('\\', '/').includes(targetSubstr)
      ) {
        triggered = true;
      }
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        response = item.text;
      }
    }
    if (event.type === 'turn.completed') {
      usage = normalizeUsage(event.usage);
    }
  }

  return {
    response,
    triggered,
    durationMs: fallbackDurationMs,
    usage,
  };
}

export interface ParseCodexGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export function parseCodexGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseCodexGraderParams): {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
} {
  const stream = parseCodexStreamJson({
    stdout,
    skillName: '',
    fallbackDurationMs,
  });
  const text = stream.response || stdout;
  return {
    output: extractJsonFromText(text),
    durationMs: stream.durationMs,
    usage: stream.usage,
  };
}

export interface CreateCodexRunnerParams {
  binary?: string;
  env?: Environment;
}

export function createCodexRunner({
  binary,
  env,
}: CreateCodexRunnerParams = {}): EvalRunner {
  const resolvedBin = binary ?? 'codex';

  return {
    name: 'codex',
    async runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult> {
      const args = buildCodexTaskArgs(request.prompt);
      const proc = await spawnRunnerProcess({
        binary: resolvedBin,
        args,
        cwd: request.workdir,
        runDir: request.runDir,
        timeoutSeconds: request.timeoutSeconds,
        env,
      });
      const parsed = parseCodexStreamJson({
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
      const args = buildCodexGraderArgs({
        prompt: request.prompt,
        schemaPath: request.schemaPath,
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
      const parsed = parseCodexGraderJson({
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
