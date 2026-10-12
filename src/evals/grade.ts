import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment } from '../env.ts';
import { lstatIfExists, readTextIfExists } from '../install/fs.ts';
import type { EvalAssertion, EvalCase, ScriptedAssertion } from './cases.ts';
import type { EvalRunner, RunnerTaskResult } from './runners/types.ts';

const COMMAND_ASSERTION_TIMEOUT_MS = 30_000;
const WORKSPACE_SKIP_DIRS = new Set([
  '.git',
  '.agents',
  '.claude',
  '.gemini',
  '.codex',
  'node_modules',
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
        },
        required: ['assertion', 'passed', 'evidence'],
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

interface RunShellCommandParams {
  command: string;
  cwd: string;
  env?: Environment;
  timeoutMs?: number;
}

interface ShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runShellCommand({
  command,
  cwd,
  env,
  timeoutMs = COMMAND_ASSERTION_TIMEOUT_MS,
}: RunShellCommandParams): Promise<ShellCommandResult> {
  return new Promise<ShellCommandResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      env: env ? { ...env } : process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: error.message,
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
      });
    });
  });
}

export interface EvaluateScriptedAssertionParams {
  assertion: ScriptedAssertion;
  workdir: string;
  env?: Environment;
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

async function listWorkspaceSummary(
  workdir: string,
  segments: readonly string[] = [],
): Promise<string[]> {
  const dir = join(workdir, ...segments);
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const lines: string[] = [];

  for (const entry of entries) {
    if (WORKSPACE_SKIP_DIRS.has(entry.name)) continue;
    const relSegments = [...segments, entry.name];
    const relPath = relSegments.join('/');
    const fullPath = join(workdir, ...relSegments);
    if (entry.isDirectory()) {
      lines.push(...(await listWorkspaceSummary(workdir, relSegments)));
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      const preview =
        info.size <= 4096
          ? ((await readTextIfExists(fullPath)) ?? '').slice(0, 600)
          : `(${info.size} bytes)`;
      lines.push(`--- ${relPath} ---\n${preview}`);
    }
  }

  return lines;
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
    'An assertion passes ONLY if there is clear, concrete evidence in the response or workspace files.',
    'Always provide a specific, non-empty evidence string explaining why each assertion passed or failed.',
    '',
    '<task_prompt>',
    evalCase.prompt,
    '</task_prompt>',
    '',
    '<expected_output>',
    evalCase.expected_output,
    '</expected_output>',
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
    '',
    '<assertions>',
    JSON.stringify(stringAssertions, null, 2),
    '</assertions>',
  ].join('\n');
}

export function normalizeGraderResults(
  stringAssertions: readonly string[],
  rawOutput: unknown,
): GradedExpectation[] {
  const rawResults =
    typeof rawOutput === 'object' &&
    rawOutput !== null &&
    'results' in rawOutput &&
    Array.isArray((rawOutput as Record<string, unknown>).results)
      ? ((rawOutput as Record<string, unknown>).results as unknown[])
      : [];

  return stringAssertions.map((assertion, index) => {
    const matched =
      rawResults.find(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          (item as Record<string, unknown>).assertion === assertion,
      ) ?? rawResults[index];

    if (typeof matched !== 'object' || matched === null) {
      return {
        text: assertion,
        kind: 'string',
        passed: false,
        evidence: 'Grader did not return a result for this assertion.',
      };
    }

    const record = matched as Record<string, unknown>;
    const rawEvidence =
      typeof record.evidence === 'string' ? record.evidence.trim() : '';
    if (!rawEvidence) {
      return {
        text: assertion,
        kind: 'string',
        passed: false,
        evidence: 'Grader provided no supporting evidence.',
      };
    }

    return {
      text: assertion,
      kind: 'string',
      passed: record.passed === true,
      evidence: rawEvidence,
    };
  });
}

export interface GradeEvalRunParams {
  evalCase: EvalCase;
  workdir: string;
  runDir: string;
  taskResult: RunnerTaskResult;
  runner: EvalRunner;
  timeoutSeconds: number;
  env?: Environment;
}

export async function gradeEvalRun({
  evalCase,
  workdir,
  runDir,
  taskResult,
  runner,
  timeoutSeconds,
  env,
}: GradeEvalRunParams): Promise<{
  grading: GradingReport;
  timing: TimingReport;
}> {
  await mkdir(runDir, { recursive: true });
  const stringAssertions = evalCase.assertions.filter(
    (item): item is string => typeof item === 'string',
  );

  let gradedStrings = new Map<string, GradedExpectation>();
  if (stringAssertions.length > 0) {
    const schemaPath = join(runDir, 'grader-schema.json');
    await writeFile(
      schemaPath,
      `${JSON.stringify(GRADER_JSON_SCHEMA, null, 2)}\n`,
    );
    const workspaceSummary = await listWorkspaceSummary(workdir);
    const prompt = buildBlindGraderPrompt({
      evalCase,
      response: taskResult.response,
      workspaceSummary,
      stringAssertions,
    });
    const graderResult = await runner.runGrader({
      prompt,
      schemaPath,
      schema: GRADER_JSON_SCHEMA,
      workdir,
      runDir,
      timeoutSeconds,
    });
    const normalized = normalizeGraderResults(
      stringAssertions,
      graderResult.output,
    );
    gradedStrings = new Map(normalized.map((item) => [item.text, item]));
  }

  const expectations: GradedExpectation[] = [];
  for (const assertion of evalCase.assertions) {
    if (typeof assertion === 'string') {
      expectations.push(
        gradedStrings.get(assertion) ?? {
          text: assertion,
          kind: 'string',
          passed: false,
          evidence: 'Grader did not return a result for this assertion.',
        },
      );
    } else {
      expectations.push(
        await evaluateScriptedAssertion({
          assertion,
          workdir,
          env,
        }),
      );
    }
  }

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
  };

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
