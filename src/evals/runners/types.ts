import type { Environment } from '../../env.ts';
import type { EvalRunnerName } from '../workspace.ts';

export type { EvalRunnerName };

export interface RunnerUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunnerTaskRequest {
  prompt: string;
  workdir: string;
  runDir: string;
  skillName: string;
  timeoutSeconds: number;
  sandbox?: boolean;
  excludeSkill?: boolean;
}

export interface RunnerTaskResult {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
  exitCode: number;
  timedOut: boolean;
  rawStdout: string;
  rawStderr: string;
  /** Why the run failed (timeout, non-zero exit, missing or error result). */
  error?: string;
  /** Whether the CLI reported token usage; defaults to `total_tokens > 0`. */
  usageReported?: boolean;
}

export interface RunnerGraderRequest {
  prompt: string;
  schemaPath: string;
  schema: Record<string, unknown>;
  workdir: string;
  runDir: string;
  timeoutSeconds: number;
}

export interface RunnerGraderResult {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
  rawStdout: string;
  rawStderr: string;
}

export interface ParsedGraderOutput {
  output: unknown;
  durationMs: number;
  usage: RunnerUsage;
}

/** What a runner's stream parser extracts from a task run's stdout. */
export interface ParsedTaskStream {
  response: string;
  triggered: boolean;
  durationMs: number;
  usage: RunnerUsage;
  usageReported: boolean;
  /** Whether the CLI emitted its final result event. */
  sawResult: boolean;
  /** Error reported by the CLI itself (error result or error event). */
  error?: string;
}

export interface EvalRunner {
  readonly name: EvalRunnerName;
  /**
   * Whether `RunnerTaskRequest.sandbox` is honored. When false, task runs
   * are not confined by the runner and callers should warn or refuse.
   */
  readonly sandboxSupported?: boolean;
  runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult>;
  runGrader(request: RunnerGraderRequest): Promise<RunnerGraderResult>;
  /** Fails fast (RunnerError) when the runner cannot start, e.g. a missing binary. */
  preflight?(): Promise<void>;
}

export interface SpawnRunnerProcessParams {
  binary: string;
  args: readonly string[];
  cwd: string;
  runDir: string;
  timeoutSeconds: number;
  /** The complete child environment; `process.env` is never inherited. */
  env: Environment;
  logPrefix?: string;
  /** Delay between SIGTERM and SIGKILL of the process group on timeout. */
  killGraceMs?: number;
  /** How long to wait for output to drain after the child exits or is killed. */
  drainMs?: number;
}

export interface SpawnRunnerProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export {
  checkRunnerBinary,
  type CheckRunnerBinaryParams,
  launchError,
  resolveRunnerBinary,
  type ResolveRunnerBinaryParams,
  runDetachedProcess,
  type RunDetachedProcessParams,
  signalProcessTree,
  spawnRunnerProcess,
} from './process.ts';
export {
  buildTaskResult,
  type BuildTaskResultParams,
  createCliRunner,
  type CreateCliRunnerParams,
  describeProcessFailure,
  type DescribeProcessFailureParams,
  emptyUsage,
  extractJsonFromText,
  isRecordObject,
  isUsageReported,
  mentionsSkillFile,
  normalizeUsage,
  parseGraderProcess,
  type ParseGraderProcessParams,
  parseJsonDocument,
  parseJsonLines,
  stderrTail,
} from './shared.ts';
