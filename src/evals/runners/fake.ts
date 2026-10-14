import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { lstatIfExists } from '../../install/fs.ts';
import { stagedSkillDir } from '../workspace.ts';
import type {
  EvalRunner,
  RunnerGraderRequest,
  RunnerGraderResult,
  RunnerTaskRequest,
  RunnerTaskResult,
} from './types.ts';

export interface FakeRunnerOptions {
  onTask?: (
    request: RunnerTaskRequest,
  ) => Promise<Partial<RunnerTaskResult>> | Partial<RunnerTaskResult>;
  onGrader?: (
    request: RunnerGraderRequest,
  ) => Promise<Partial<RunnerGraderResult>> | Partial<RunnerGraderResult>;
  /** Called by `preflight()`; throw a RunnerError to simulate a missing CLI. */
  onPreflight?: () => Promise<void> | void;
  /** Reported as `EvalRunner.sandboxSupported` (default true). */
  sandboxSupported?: boolean;
}

interface SkillActiveCheckParams {
  workdir: string;
  skillName: string;
}

/**
 * The fake runner "sees" the skill when it is staged where the harness stages
 * it for the fake runner. Baseline workspaces never stage it, and
 * `excludeSkill` is honored as well.
 */
async function isSkillActiveInWorkdir({
  workdir,
  skillName,
}: SkillActiveCheckParams): Promise<boolean> {
  const skillFile = join(
    stagedSkillDir({ workdir, runner: 'fake', skillName }),
    'SKILL.md',
  );

  return (await lstatIfExists(skillFile)) !== null;
}

export interface FakeTriggerDecisionParams {
  prompt: string;
  skillName: string;
}

/**
 * The fake runner's default trigger decision when the skill is staged: a
 * stable hash of the skill name and prompt puts about half of all prompts in
 * the "triggered" bucket. It reads no labels from the prompt, so trigger
 * metrics from the fake runner are arbitrary; they only exercise the suite
 * structure in dry runs. Tests that need specific outcomes use `onTask`.
 */
export function fakeTriggerDecision({
  prompt,
  skillName,
}: FakeTriggerDecisionParams): boolean {
  const digest = createHash('sha256')
    .update(`${skillName}\0${prompt}`)
    .digest('hex');

  return Number.parseInt(digest.slice(0, 8), 16) % 100 < 50;
}

function extractAssertionsFromGraderPrompt(prompt: string): string[] {
  const match =
    /<assertions>\s*([\s\S]*?)\s*<\/assertions>/.exec(prompt) ??
    /Assertions JSON:\s*(\[[\s\S]*?\])/.exec(prompt);

  if (!match?.[1]) return [];

  try {
    const parsed: unknown = JSON.parse(match[1]);

    if (
      Array.isArray(parsed) &&
      parsed.every((item): item is string => typeof item === 'string')
    ) {
      return parsed;
    }
  } catch {
    return [];
  }

  return [];
}

export function createFakeRunner({
  onTask,
  onGrader,
  onPreflight,
  sandboxSupported = true,
}: FakeRunnerOptions = {}): EvalRunner {
  return {
    name: 'fake',
    sandboxSupported,
    async preflight(): Promise<void> {
      await onPreflight?.();
    },
    async runTask({
      prompt,
      workdir,
      runDir,
      skillName,
      timeoutSeconds,
      sandbox,
      excludeSkill,
    }: RunnerTaskRequest): Promise<RunnerTaskResult> {
      await mkdir(runDir, { recursive: true });

      const active =
        !excludeSkill &&
        (await isSkillActiveInWorkdir({
          workdir,
          skillName,
        }));
      const custom = onTask
        ? await onTask({
            prompt,
            workdir,
            runDir,
            skillName,
            timeoutSeconds,
            sandbox,
            excludeSkill,
          })
        : {};

      const shouldTriggerDefault =
        active && fakeTriggerDecision({ prompt, skillName });
      const response =
        custom.response ??
        (active
          ? `Executed with skill ${skillName}: ${prompt}`
          : `Executed without skill: ${prompt}`);
      const triggered = custom.triggered ?? shouldTriggerDefault;
      const durationMs = custom.durationMs ?? (active ? 120 : 90);
      const usage = custom.usage ?? {
        input_tokens: active ? 120 : 80,
        output_tokens: active ? 60 : 40,
        total_tokens: active ? 180 : 120,
      };
      const exitCode = custom.exitCode ?? 0;
      const timedOut = custom.timedOut ?? false;
      const rawStdout =
        custom.rawStdout ??
        `${JSON.stringify({
          type: 'result',
          response,
          duration_ms: durationMs,
          usage,
        })}\n`;
      const rawStderr = custom.rawStderr ?? '';
      const usageReported = custom.usageReported ?? usage.total_tokens > 0;

      await writeFile(join(runDir, 'stdout.log'), rawStdout);
      await writeFile(join(runDir, 'stderr.log'), rawStderr);

      return {
        response,
        triggered,
        durationMs,
        usage,
        usageReported,
        exitCode,
        timedOut,
        rawStdout,
        rawStderr,
        ...(custom.error !== undefined ? { error: custom.error } : {}),
      };
    },

    async runGrader({
      prompt,
      schemaPath,
      schema,
      workdir,
      runDir,
      timeoutSeconds,
    }: RunnerGraderRequest): Promise<RunnerGraderResult> {
      await mkdir(runDir, { recursive: true });

      const custom = onGrader
        ? await onGrader({
            prompt,
            schemaPath,
            schema,
            workdir,
            runDir,
            timeoutSeconds,
          })
        : {};

      const assertions = extractAssertionsFromGraderPrompt(prompt);
      const passedDefault = prompt.includes('Executed with skill');
      const output = custom.output ?? {
        results: assertions.map((assertion) => ({
          assertion,
          passed: passedDefault,
          evidence: passedDefault
            ? `Transcript confirms "${assertion}" via skill execution.`
            : 'No supporting evidence found in baseline transcript.',
        })),
      };
      const durationMs = custom.durationMs ?? 50;
      const usage = custom.usage ?? {
        input_tokens: 50,
        output_tokens: 25,
        total_tokens: 75,
      };
      const rawStdout =
        custom.rawStdout ??
        `${JSON.stringify({
          type: 'result',
          structured_output: output,
          duration_ms: durationMs,
          usage,
        })}\n`;
      const rawStderr = custom.rawStderr ?? '';

      await writeFile(join(runDir, 'grader-stdout.log'), rawStdout);
      await writeFile(join(runDir, 'grader-stderr.log'), rawStderr);

      return {
        output,
        durationMs,
        usage,
        rawStdout,
        rawStderr,
      };
    },
  };
}
