import type { AgyConfig, Environment } from '../../env.ts';
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

export function buildAgyGraderArgs({
  prompt,
  schemaPath,
  timeoutSeconds,
  extraArgs = [],
}: BuildAgyGraderArgsParams): string[] {
  return [
    '--dangerously-skip-permissions',
    `--print-timeout=${timeoutSeconds}s`,
    '--output-format=json',
    `--json-schema=${schemaPath}`,
    ...extraArgs,
    `-p=${prompt}`,
  ];
}

export interface ParseAgyStreamParams {
  stdout: string;
  skillName: string;
  fallbackDurationMs?: number;
}

export interface ParsedAgyStream {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
}

function isAgySkillTriggerStep(
  event: Record<string, unknown>,
  skillName: string,
): boolean {
  if (event.type !== 'step_update') return false;
  const toolName = event.tool_name;
  const toolInfo =
    typeof event.tool_info === 'object' && event.tool_info !== null
      ? (event.tool_info as Record<string, unknown>)
      : undefined;
  const params =
    toolInfo &&
    typeof toolInfo.parameters === 'object' &&
    toolInfo.parameters !== null
      ? (toolInfo.parameters as Record<string, unknown>)
      : undefined;
  if (!params) return false;

  const targetSuffix = `/${skillName}/SKILL.md`;
  const targetSubstr = `${skillName}/SKILL.md`;

  if (toolName === 'view_file' && typeof params.AbsolutePath === 'string') {
    const normalized = params.AbsolutePath.replaceAll('\\', '/');
    return normalized.endsWith(targetSuffix) || normalized === targetSubstr;
  }
  if (toolName === 'run_command' && typeof params.CommandLine === 'string') {
    const normalized = params.CommandLine.replaceAll('\\', '/');
    return normalized.includes(targetSubstr);
  }
  return false;
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

  for (const event of events) {
    if (isAgySkillTriggerStep(event, skillName)) {
      triggered = true;
    }
    if (event.type === 'result') {
      if (typeof event.response === 'string') {
        response = event.response;
      }
      if (typeof event.duration_ms === 'number') {
        durationMs = event.duration_ms;
      } else if (typeof event.duration_seconds === 'number') {
        durationMs = Math.round(event.duration_seconds * 1000);
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

export interface ParseAgyGraderParams {
  stdout: string;
  fallbackDurationMs?: number;
}

export interface ParsedAgyGrader {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
}

export function parseAgyGraderJson({
  stdout,
  fallbackDurationMs = 0,
}: ParseAgyGraderParams): ParsedAgyGrader {
  const doc = parseJsonDocument(stdout);
  const durationMs =
    typeof doc.duration_ms === 'number'
      ? doc.duration_ms
      : typeof doc.duration_seconds === 'number'
        ? Math.round(doc.duration_seconds * 1000)
        : fallbackDurationMs;
  const usage = normalizeUsage(doc.usage);

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
  env?: Environment;
}

export function createAgyRunner({
  binary,
  agyConfig,
  env,
}: CreateAgyRunnerParams = {}): EvalRunner {
  const resolvedBin = binary ?? agyConfig?.bin ?? 'agy';
  const extraArgs = agyConfig?.extraArgs ?? [];

  return {
    name: 'agy',
    async runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult> {
      const args = buildAgyTaskArgs({
        prompt: request.prompt,
        timeoutSeconds: request.timeoutSeconds,
        sandbox: request.sandbox,
        extraArgs,
      });
      const proc = await spawnRunnerProcess({
        binary: resolvedBin,
        args,
        cwd: request.workdir,
        runDir: request.runDir,
        timeoutSeconds: request.timeoutSeconds,
        env,
      });
      const parsed = parseAgyStreamJson({
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
      const args = buildAgyGraderArgs({
        prompt: request.prompt,
        schemaPath: request.schemaPath,
        timeoutSeconds: request.timeoutSeconds,
        extraArgs,
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
      const parsed = parseAgyGraderJson({
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
