import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { lstatIfExists, readTextIfExists } from '../../install/fs.ts';
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
}

interface SkillActiveCheckParams {
  workdir: string;
  skillName: string;
}

async function isSkillActiveInWorkdir({
  workdir,
  skillName,
}: SkillActiveCheckParams): Promise<boolean> {
  if (
    (await lstatIfExists(
      join(workdir, '.agents', 'skills', skillName, 'SKILL.md'),
    )) === null
  ) {
    return false;
  }
  const excludeJson = await readTextIfExists(
    join(workdir, '.agents', 'skills.json'),
  );
  if (excludeJson) {
    try {
      const parsed = JSON.parse(excludeJson) as { exclude?: unknown };
      if (Array.isArray(parsed.exclude) && parsed.exclude.includes(skillName)) {
        return false;
      }
    } catch {
      return true;
    }
  }
  return true;
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

export function createFakeRunner(options: FakeRunnerOptions = {}): EvalRunner {
  return {
    name: 'fake',
    async runTask(request: RunnerTaskRequest): Promise<RunnerTaskResult> {
      await mkdir(request.runDir, { recursive: true });
      const active =
        !request.excludeSkill &&
        (await isSkillActiveInWorkdir({
          workdir: request.workdir,
          skillName: request.skillName,
        }));
      const custom = options.onTask ? await options.onTask(request) : {};

      const shouldTriggerDefault =
        active && !request.prompt.includes('[negative]');
      const response =
        custom.response ??
        (active
          ? `Executed with skill ${request.skillName}: ${request.prompt}`
          : `Executed without skill: ${request.prompt}`);
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

      await writeFile(join(request.runDir, 'stdout.log'), rawStdout);
      await writeFile(join(request.runDir, 'stderr.log'), rawStderr);

      return {
        response,
        triggered,
        durationMs,
        usage,
        exitCode,
        timedOut,
        rawStdout,
        rawStderr,
      };
    },

    async runGrader(request: RunnerGraderRequest): Promise<RunnerGraderResult> {
      await mkdir(request.runDir, { recursive: true });
      const custom = options.onGrader ? await options.onGrader(request) : {};

      const assertions = extractAssertionsFromGraderPrompt(request.prompt);
      const passedDefault = request.prompt.includes('Executed with skill');
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

      await writeFile(join(request.runDir, 'grader-stdout.log'), rawStdout);
      await writeFile(join(request.runDir, 'grader-stderr.log'), rawStderr);

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
