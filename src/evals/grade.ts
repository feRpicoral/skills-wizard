import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment } from '../env.ts';
import { lstatIfExists, readTextIfExists } from '../install/fs.ts';
import type { EvalAssertion, EvalCase, ScriptedAssertion } from './cases.ts';
import type { EvalRunner, RunnerTaskResult } from './runners/types.ts';

const COMMAND_ASSERTION_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_DRAIN_MS = 1_000;
const WORKSPACE_SUMMARY_BUDGET = 60_000;
const FILE_PREVIEW_CHARS = 8_000;
const MAX_LISTED_SHORTENED_FILES = 200;
const MALFORMED_GRADER_OUTPUT = 'Malformed grader output';
const WORKSPACE_SKIP_DIRS = new Set([
  '.git',
  '.agents',
  '.claude',
  '.gemini',
  '.codex',
  '.cache',
  '.gradle',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.pytest_cache',
  '.tox',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

export const GRADER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          assertion: { type: 'string' },
          passed: { type: 'boolean' },
          evidence: { type: 'string' },
          quote: { type: 'string' },
        },
        // Strict structured-output modes need every property listed; an empty
        // quote means the grader had nothing to quote.
        required: ['assertion', 'passed', 'evidence', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

export interface GradedExpectation {
  text: string;
  kind: 'string' | ScriptedAssertion['type'];
  passed: boolean;
  evidence: string;
}

export interface GradingSummary {
  passed: number;
  failed: number;
  total: number;
  pass_rate: number;
}

export interface GradingReport {
  expectations: GradedExpectation[];
  summary: GradingSummary;
}

export interface TimingReport {
  duration_ms: number;
  total_duration_seconds: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  triggered: boolean;
  exit_code: number;
  timed_out: boolean;
  /** False when the runner reported no token usage; token fields are then 0. */
  usage_reported?: boolean;
  /** Why the agent run failed, when it did. */
  error?: string;
}

export function formatAssertionLabel(assertion: EvalAssertion): string {
  if (typeof assertion === 'string') {
    return assertion;
  }
  switch (assertion.type) {
    case 'file_exists':
      return `file_exists: ${assertion.path}`;
    case 'file_absent':
      return `file_absent: ${assertion.path}`;
    case 'regex':
      return `regex: ${assertion.path} matches /${assertion.pattern}/${assertion.flags ?? ''}`;
    case 'json_valid':
      return `json_valid: ${assertion.path}`;
    case 'command':
      return `command: ${assertion.run} (expect ${assertion.expect})`;
  }
}

export interface RunShellCommandParams {
  command: string;
  cwd: string;
  env: Environment;
  timeoutMs?: number;
}

export interface ShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface SignalGroupParams {
  child: ChildProcess;
  signal: NodeJS.Signals;
}

// The command runs in its own process group, so the whole tree (the shell and
// anything it started) is signalled, not only the shell.
function signalGroup({ child, signal }: SignalGroupParams): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The group is already gone.
  }
}

export async function runShellCommand({
  command,
  cwd,
  env,
  timeoutMs = COMMAND_ASSERTION_TIMEOUT_MS,
}: RunShellCommandParams): Promise<ShellCommandResult> {
  return new Promise<ShellCommandResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...env },
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const openStreams = new Set(['stdout', 'stderr']);
    const timers: NodeJS.Timeout[] = [];
    let timedOut = false;
    let exited = false;
    let exitCode: number | null = null;
    let settled = false;

    const finish = (spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      // Stragglers that outlived the shell would otherwise keep running.
      signalGroup({ child, signal: 'SIGKILL' });
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        exitCode: spawnError ? 1 : (exitCode ?? (timedOut ? 124 : 1)),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: spawnError
          ? spawnError.message
          : Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    };

    const streamClosed = (name: string): void => {
      openStreams.delete(name);
      if (exited && openStreams.size === 0) finish();
    };

    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalGroup({ child, signal: 'SIGTERM' });
        timers.push(
          setTimeout(() => {
            signalGroup({ child, signal: 'SIGKILL' });
            // Settle even if the exit event never arrives.
            timers.push(setTimeout(() => finish(), OUTPUT_DRAIN_MS));
          }, KILL_GRACE_MS),
        );
      }, timeoutMs),
    );

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.stdout.on('close', () => streamClosed('stdout'));
    child.stderr.on('close', () => streamClosed('stderr'));

    child.on('error', (error) => finish(error));

    // Settle on exit rather than close: a background process that inherited
    // the pipes would hold close open. Give the output a short drain window.
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (openStreams.size === 0) {
        finish();
      } else {
        timers.push(setTimeout(() => finish(), OUTPUT_DRAIN_MS));
      }
    });
  });
}

export interface EvaluateScriptedAssertionParams {
  assertion: ScriptedAssertion;
  workdir: string;
  env: Environment;
}

export async function evaluateScriptedAssertion({
  assertion,
  workdir,
  env,
}: EvaluateScriptedAssertionParams): Promise<GradedExpectation> {
  const text = formatAssertionLabel(assertion);

  if (assertion.type === 'file_exists') {
    const fullPath = join(workdir, assertion.path);
    const info = await lstatIfExists(fullPath);
    if (info !== null) {
      return {
        text,
        kind: 'file_exists',
        passed: true,
        evidence: `Found "${assertion.path}" in workspace.`,
      };
    }
    return {
      text,
      kind: 'file_exists',
      passed: false,
      evidence: `File "${assertion.path}" does not exist in workspace.`,
    };
  }

  if (assertion.type === 'file_absent') {
    const fullPath = join(workdir, assertion.path);
    const info = await lstatIfExists(fullPath);
    if (info === null) {
      return {
        text,
        kind: 'file_absent',
        passed: true,
        evidence: `Confirmed "${assertion.path}" is absent from workspace.`,
      };
    }
    return {
      text,
      kind: 'file_absent',
      passed: false,
      evidence: `File "${assertion.path}" exists in workspace but was expected to be absent.`,
    };
  }

  if (assertion.type === 'regex') {
    const fullPath = join(workdir, assertion.path);
    const content = await readTextIfExists(fullPath);
    if (content === null) {
      return {
        text,
        kind: 'regex',
        passed: false,
        evidence: `File "${assertion.path}" does not exist in workspace.`,
      };
    }
    const regex = new RegExp(assertion.pattern, assertion.flags);
    const match = regex.exec(content);
    if (match) {
      const snippet = match[0].slice(0, 160).replaceAll('\n', '\\n');
      return {
        text,
        kind: 'regex',
        passed: true,
        evidence: `Matched /${assertion.pattern}/${assertion.flags ?? ''} in "${assertion.path}": "${snippet}"`,
      };
    }
    return {
      text,
      kind: 'regex',
      passed: false,
      evidence: `Pattern /${assertion.pattern}/${assertion.flags ?? ''} did not match "${assertion.path}".`,
    };
  }

  if (assertion.type === 'json_valid') {
    const fullPath = join(workdir, assertion.path);
    const content = await readTextIfExists(fullPath);
    if (content === null) {
      return {
        text,
        kind: 'json_valid',
        passed: false,
        evidence: `File "${assertion.path}" does not exist in workspace.`,
      };
    }
    try {
      JSON.parse(content);
      return {
        text,
        kind: 'json_valid',
        passed: true,
        evidence: `Parsed "${assertion.path}" as valid JSON.`,
      };
    } catch (error) {
      return {
        text,
        kind: 'json_valid',
        passed: false,
        evidence: `Invalid JSON in "${assertion.path}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const result = await runShellCommand({
    command: assertion.run,
    cwd: workdir,
    env,
  });
  const passed = !result.timedOut && result.exitCode === assertion.expect;
  const outputPreview = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 240);
  const detail = result.timedOut
    ? 'Command timed out'
    : `Exit code ${result.exitCode} (expected ${assertion.expect})`;
  return {
    text,
    kind: 'command',
    passed,
    evidence: outputPreview ? `${detail}: ${outputPreview}` : detail,
  };
}

interface WorkspaceFile {
  relPath: string;
  fullPath: string;
  size: number;
}

interface CollectWorkspaceFilesParams {
  workdir: string;
  segments?: readonly string[];
}

async function collectWorkspaceFiles({
  workdir,
  segments = [],
}: CollectWorkspaceFilesParams): Promise<WorkspaceFile[]> {
  const entries = await readdir(join(workdir, ...segments), {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: WorkspaceFile[] = [];
  for (const entry of entries) {
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    const relSegments = [...segments, entry.name];
    if (entry.isDirectory()) {
      files.push(
        ...(await collectWorkspaceFiles({ workdir, segments: relSegments })),
      );
    } else if (entry.isFile()) {
      const fullPath = join(workdir, ...relSegments);
      const info = await stat(fullPath);
      files.push({ relPath: relSegments.join('/'), fullPath, size: info.size });
    }
  }
  return files;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface SummarizeWorkspaceParams {
  workdir: string;
  /** Total characters of file content to include. */
  budget?: number;
}

/**
 * Renders workspace files for the blind grader: text files only, each capped,
 * the whole summary capped, build and vendor folders skipped. Files that were
 * cut short or left out are listed by path and size at the end.
 */
export async function summarizeWorkspace({
  workdir,
  budget = WORKSPACE_SUMMARY_BUDGET,
}: SummarizeWorkspaceParams): Promise<string[]> {
  const files = await collectWorkspaceFiles({ workdir });
  const sections: string[] = [];
  const shortened: string[] = [];
  let remaining = budget;

  for (const file of files) {
    if (remaining <= 0) {
      shortened.push(`${file.relPath} (${file.size} bytes, omitted)`);
      continue;
    }
    const head = await readHead(
      file.fullPath,
      Math.min(file.size, FILE_PREVIEW_CHARS + 1),
    );
    if (head.includes(0)) {
      const line = `--- ${file.relPath} (binary, ${file.size} bytes) ---`;
      sections.push(line);
      remaining -= line.length;
      continue;
    }
    const text = head.toString('utf8');
    const limit = Math.min(FILE_PREVIEW_CHARS, remaining);
    const preview = text.slice(0, limit);
    const truncated = file.size > Buffer.byteLength(preview, 'utf8');
    const header = truncated
      ? `--- ${file.relPath} (truncated, ${file.size} bytes) ---`
      : `--- ${file.relPath} ---`;
    if (truncated) {
      shortened.push(`${file.relPath} (${file.size} bytes, truncated)`);
    }
    sections.push(`${header}\n${preview}`);
    remaining -= header.length + preview.length;
  }

  if (shortened.length > 0) {
    const listed = shortened.slice(0, MAX_LISTED_SHORTENED_FILES);
    const more = shortened.length - listed.length;
    sections.push(
      [
        '--- files not shown in full (summary limit) ---',
        ...listed,
        ...(more > 0 ? [`... and ${more} more`] : []),
      ].join('\n'),
    );
  }

  return sections;
}

export interface BuildBlindGraderPromptParams {
  evalCase: EvalCase;
  response: string;
  workspaceSummary: readonly string[];
  stringAssertions: readonly string[];
}

export function buildBlindGraderPrompt({
  evalCase,
  response,
  workspaceSummary,
  stringAssertions,
}: BuildBlindGraderPromptParams): string {
  return [
    'You are an impartial, blind evaluation grader.',
    'Evaluate each assertion against the task prompt, expected output description, agent response, and workspace files.',
    'Do not call any tools, read files, or run commands; grade strictly from the <agent_response> and <workspace_files> provided below and return the structured JSON output immediately.',
    'An assertion passes ONLY if there is clear, concrete evidence in the response or workspace files.',
    'Always provide a specific, non-empty evidence string explaining why each assertion passed or failed.',
    '',
    'Output format: a single JSON object {"results": [{"assertion": string, "passed": boolean, "evidence": string, "quote": string}]}.',
    '- Return exactly one result per assertion, in the order the assertions are listed.',
    '- "assertion" must repeat the assertion text verbatim, character for character.',
    '- "passed" is true only when the evidence supports the assertion.',
    '- "evidence" explains the verdict in one or two sentences.',
    '- "quote" is a short excerpt copied verbatim from the agent response or a workspace file that supports a passing verdict; use "" when there is nothing to quote.',
    '',
    '<task_prompt>',
    evalCase.prompt,
    '</task_prompt>',
    '',
    '<expected_output>',
    evalCase.expected_output,
    '</expected_output>',
    '',
    '<assertions>',
    JSON.stringify(stringAssertions, null, 2),
    '</assertions>',
    '',
    '<agent_response>',
    response || '(empty response)',
    '</agent_response>',
    '',
    '<workspace_files>',
    workspaceSummary.length > 0
      ? workspaceSummary.join('\n\n')
      : '(no workspace files)',
    '</workspace_files>',
  ].join('\n');
}

interface GraderResultItem {
  assertion: string;
  passed: boolean;
  evidence: string;
  quote: string;
}

function parseGraderItem(raw: unknown): GraderResultItem | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.assertion !== 'string' ||
    typeof record.passed !== 'boolean' ||
    typeof record.evidence !== 'string'
  ) {
    return null;
  }
  return {
    assertion: record.assertion,
    passed: record.passed,
    evidence: record.evidence.trim(),
    quote: typeof record.quote === 'string' ? record.quote.trim() : '',
  };
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function failedString(assertion: string, evidence: string): GradedExpectation {
  return { text: assertion, kind: 'string', passed: false, evidence };
}

export interface NormalizeGraderResultsParams {
  assertions: readonly string[];
  output: unknown;
  /**
   * Text the grader saw (response and workspace summary). When given, a passing
   * result whose `quote` does not occur in it is downgraded to failed.
   */
  evidenceText?: string;
}

/**
 * Matches grader results to assertions by exact text first. Results are taken
 * by position only when the grader returned exactly one result per assertion
 * and that slot was not already matched; anything else fails closed.
 */
export function normalizeGraderResults({
  assertions,
  output,
  evidenceText,
}: NormalizeGraderResultsParams): GradedExpectation[] {
  const rawResults =
    typeof output === 'object' &&
    output !== null &&
    Array.isArray((output as Record<string, unknown>).results)
      ? ((output as Record<string, unknown>).results as unknown[])
      : null;
  if (rawResults === null) {
    return assertions.map((assertion) =>
      failedString(
        assertion,
        `${MALFORMED_GRADER_OUTPUT}: expected an object with a "results" array.`,
      ),
    );
  }

  const items = rawResults.map(parseGraderItem);
  const used = new Set<number>();
  const matched = new Array<GraderResultItem | undefined>(assertions.length);

  for (const [index, assertion] of assertions.entries()) {
    const found = items.findIndex(
      (item, position) =>
        item !== null && !used.has(position) && item.assertion === assertion,
    );
    if (found !== -1) {
      used.add(found);
      matched[index] = items[found] ?? undefined;
    }
  }
  if (items.length === assertions.length) {
    for (const index of assertions.keys()) {
      const item = items[index];
      if (matched[index] === undefined && !used.has(index) && item) {
        used.add(index);
        matched[index] = item;
      }
    }
  }

  const haystack =
    evidenceText === undefined ? undefined : collapseWhitespace(evidenceText);

  return assertions.map((assertion, index) => {
    const item = matched[index];
    if (item === undefined) {
      return failedString(
        assertion,
        `${MALFORMED_GRADER_OUTPUT}: no result matched this assertion (${rawResults.length} results for ${assertions.length} assertions).`,
      );
    }
    if (!item.evidence) {
      return failedString(assertion, 'Grader provided no supporting evidence.');
    }
    if (
      item.passed &&
      item.quote &&
      haystack !== undefined &&
      !haystack.includes(collapseWhitespace(item.quote))
    ) {
      return failedString(
        assertion,
        `Unverified evidence: the quoted text was not found in the response or workspace files. ${item.evidence}`,
      );
    }
    return {
      text: assertion,
      kind: 'string',
      passed: item.passed,
      evidence: item.evidence,
    };
  });
}

export interface RunFailureParams {
  taskResult: RunnerTaskResult;
  timeoutSeconds: number;
}

/** Why the agent run failed, or undefined when it completed. */
export function runFailure({
  taskResult,
  timeoutSeconds,
}: RunFailureParams): string | undefined {
  if (taskResult.error) return taskResult.error;
  if (taskResult.timedOut) return `Timed out after ${timeoutSeconds}s`;
  return undefined;
}

export interface GradeResult {
  grading: GradingReport;
  timing: TimingReport;
}

interface WriteRunReportsParams {
  runDir: string;
  expectations: GradedExpectation[];
  taskResult: RunnerTaskResult;
  error?: string;
}

async function writeRunReports({
  runDir,
  expectations,
  taskResult,
  error,
}: WriteRunReportsParams): Promise<GradeResult> {
  const passed = expectations.filter((item) => item.passed).length;
  const total = expectations.length;
  const failed = total - passed;
  const passRate = total === 0 ? 1 : Number((passed / total).toFixed(4));

  const grading: GradingReport = {
    expectations,
    summary: {
      passed,
      failed,
      total,
      pass_rate: passRate,
    },
  };

  const timing: TimingReport = {
    duration_ms: taskResult.durationMs,
    total_duration_seconds: Number((taskResult.durationMs / 1000).toFixed(3)),
    input_tokens: taskResult.usage.input_tokens,
    output_tokens: taskResult.usage.output_tokens,
    total_tokens: taskResult.usage.total_tokens,
    triggered: taskResult.triggered,
    exit_code: taskResult.exitCode,
    timed_out: taskResult.timedOut,
    usage_reported:
      taskResult.usageReported ?? taskResult.usage.total_tokens > 0,
    ...(error === undefined ? {} : { error }),
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'grading.json'),
    `${JSON.stringify(grading, null, 2)}\n`,
  );
  await writeFile(
    join(runDir, 'timing.json'),
    `${JSON.stringify(timing, null, 2)}\n`,
  );

  return { grading, timing };
}

function failedExpectations(
  evalCase: EvalCase,
  evidence: string,
): GradedExpectation[] {
  return evalCase.assertions.map((assertion) => ({
    text: formatAssertionLabel(assertion),
    kind: typeof assertion === 'string' ? 'string' : assertion.type,
    passed: false,
    evidence,
  }));
}

export interface RecordFailedRunParams {
  evalCase: EvalCase;
  runDir: string;
  error: string;
  durationMs: number;
}

/**
 * Records a run whose agent could not run at all (the runner threw): every
 * assertion fails and timing carries the error.
 */
export async function recordFailedRun({
  evalCase,
  runDir,
  error,
  durationMs,
}: RecordFailedRunParams): Promise<GradeResult> {
  return writeRunReports({
    runDir,
    expectations: failedExpectations(evalCase, `Agent run failed: ${error}`),
    taskResult: {
      response: '',
      triggered: false,
      durationMs,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      exitCode: 1,
      timedOut: false,
      rawStdout: '',
      rawStderr: '',
      usageReported: false,
    },
    error,
  });
}

export interface GradeEvalRunParams {
  evalCase: EvalCase;
  workdir: string;
  runDir: string;
  taskResult: RunnerTaskResult;
  runner: EvalRunner;
  timeoutSeconds: number;
  env: Environment;
}

export async function gradeEvalRun({
  evalCase,
  workdir,
  runDir,
  taskResult,
  runner,
  timeoutSeconds,
  env,
}: GradeEvalRunParams): Promise<GradeResult> {
  await mkdir(runDir, { recursive: true });

  const failure = runFailure({ taskResult, timeoutSeconds });
  if (failure !== undefined) {
    return writeRunReports({
      runDir,
      expectations: failedExpectations(
        evalCase,
        `Agent run failed: ${failure}`,
      ),
      taskResult,
      error: failure,
    });
  }

  const scriptedByIndex = new Map<number, GradedExpectation>();
  const stringAssertions: string[] = [];
  const stringIndexes: number[] = [];

  for (const [index, assertion] of evalCase.assertions.entries()) {
    if (typeof assertion === 'string') {
      stringAssertions.push(assertion);
      stringIndexes.push(index);
    } else {
      scriptedByIndex.set(
        index,
        await evaluateScriptedAssertion({
          assertion,
          workdir,
          env,
        }),
      );
    }
  }

  const gradedStrings = new Map<number, GradedExpectation>();
  if (stringAssertions.length > 0) {
    const schemaPath = join(runDir, 'grader-schema.json');
    await writeFile(
      schemaPath,
      `${JSON.stringify(GRADER_JSON_SCHEMA, null, 2)}\n`,
    );
    // The grader runs in an empty folder of its own so it cannot read the
    // workspace (which would reveal the variant) or change it.
    const graderDir = join(runDir, 'grader-cwd');
    await rm(graderDir, { recursive: true, force: true });
    await mkdir(graderDir, { recursive: true });
    const workspaceSummary = await summarizeWorkspace({ workdir });
    const prompt = buildBlindGraderPrompt({
      evalCase,
      response: taskResult.response,
      workspaceSummary,
      stringAssertions,
    });
    let normalized: GradedExpectation[];
    try {
      const graderResult = await runner.runGrader({
        prompt,
        schemaPath,
        schema: GRADER_JSON_SCHEMA,
        workdir: graderDir,
        runDir,
        timeoutSeconds,
      });
      normalized = normalizeGraderResults({
        assertions: stringAssertions,
        output: graderResult.output,
        evidenceText: [taskResult.response, ...workspaceSummary].join('\n'),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      normalized = stringAssertions.map((assertion) =>
        failedString(assertion, `Grader error: ${message}`),
      );
    }
    for (const [position, item] of normalized.entries()) {
      const index = stringIndexes[position];
      if (index !== undefined) gradedStrings.set(index, item);
    }
  }

  const expectations: GradedExpectation[] = evalCase.assertions.map(
    (assertion, index) => {
      if (typeof assertion === 'string') {
        return (
          gradedStrings.get(index) ??
          failedString(
            assertion,
            'Grader did not return a result for this assertion.',
          )
        );
      }
      return (
        scriptedByIndex.get(index) ?? {
          text: formatAssertionLabel(assertion),
          kind: assertion.type,
          passed: false,
          evidence: 'Scripted assertion was not evaluated.',
        }
      );
    },
  );

  return writeRunReports({ runDir, expectations, taskResult });
}
