import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Environment } from '../env.ts';
import { lstatIfExists, statIfExists } from '../install/fs.ts';
import type { EvalAssertion, ScriptedAssertion } from './cases.ts';
import type { GradedExpectation } from './grade.ts';
import { runDetachedProcess } from './runners/process.ts';

const COMMAND_ASSERTION_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const OUTPUT_DRAIN_MS = 1_000;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes a shell command in its own process group so the shell and any child
 * processes it spawns can be signalled together. If the command exceeds
 * `timeoutMs`, the entire process group receives `SIGTERM`, followed by
 * `SIGKILL` after a 2s grace period, and resolves with `timedOut: true` (and
 * exit code `124` if the process had not yet exited).
 */
export async function runShellCommand({
  command,
  cwd,
  env,
  timeoutMs = COMMAND_ASSERTION_TIMEOUT_MS,
}: RunShellCommandParams): Promise<ShellCommandResult> {
  try {
    const result = await runDetachedProcess({
      command,
      cwd,
      env,
      shell: true,
      timeoutMs,
      killGraceMs: KILL_GRACE_MS,
      drainMs: OUTPUT_DRAIN_MS,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: errorMessage(error),
      timedOut: false,
    };
  }
}

export interface EvaluateScriptedAssertionParams {
  assertion: ScriptedAssertion;
  workdir: string;
  env: Environment;
}

/**
 * Evaluates one scripted assertion. Whatever the agent left in the workspace
 * (a folder where a file was expected, an unreadable file), the result is a
 * failed expectation with the reason as evidence, never an exception.
 */
export async function evaluateScriptedAssertion(
  params: EvaluateScriptedAssertionParams,
): Promise<GradedExpectation> {
  try {
    return await evaluateScriptedAssertionUnchecked(params);
  } catch (error) {
    return {
      text: formatAssertionLabel(params.assertion),
      kind: params.assertion.type,
      passed: false,
      evidence: `Could not evaluate assertion: ${errorMessage(error)}`,
    };
  }
}

interface ReadWorkspaceFileParams {
  workdir: string;
  path: string;
}

type WorkspaceFileRead =
  | { content: string; problem?: undefined }
  | { content?: undefined; problem: string };

// Only regular files are read: a folder or a FIFO at the path is reported
// instead of failing (EISDIR) or blocking.
async function readWorkspaceFile({
  workdir,
  path,
}: ReadWorkspaceFileParams): Promise<WorkspaceFileRead> {
  const fullPath = join(workdir, path);
  const info = await statIfExists(fullPath);

  if (info === null) {
    return { problem: `File "${path}" does not exist in workspace.` };
  }

  if (!info.isFile()) {
    return { problem: `"${path}" in workspace is not a regular file.` };
  }

  return { content: await readFile(fullPath, 'utf8') };
}

async function evaluateScriptedAssertionUnchecked({
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
    const { content, problem } = await readWorkspaceFile({
      workdir,
      path: assertion.path,
    });

    if (content === undefined) {
      return { text, kind: 'regex', passed: false, evidence: problem };
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
    const { content, problem } = await readWorkspaceFile({
      workdir,
      path: assertion.path,
    });

    if (content === undefined) {
      return { text, kind: 'json_valid', passed: false, evidence: problem };
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
        evidence: `Invalid JSON in "${assertion.path}": ${errorMessage(error)}`,
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
