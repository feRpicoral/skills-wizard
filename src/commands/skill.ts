import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import {
  runSkillEvalCommand,
  runSkillReportCommand,
  runSkillTriggersCommand,
  warnUnsupportedSandbox,
} from './skill/eval.ts';
import { runSkillNewCommand, type SkillTemplate } from './skill/new.ts';
import { runSkillValidate } from './skill/validate.ts';

export { type SkillTemplate, warnUnsupportedSandbox };

export interface SkillCommandOptions {
  subcommand: string | undefined;
  paths: string[];
  catalog?: boolean;
  template?: string;
  withEvals?: boolean;
  runner?: string;
  binary?: string;
  runs?: number;
  baseline?: boolean;
  compare?: string;
  forceCompareRef?: boolean;
  caseId?: string;
  cases?: readonly string[];
  parallel?: number;
  timeout?: number;
  sandbox?: boolean;
  keepWorkdirs?: boolean;
  split?: string;
  threshold?: number;
}

const SKILL_USAGE =
  'Usage: agents-config skill validate [path...] [--catalog] | new <name> | eval <name> | triggers <name> | report <name|run-dir> [iteration-dir]';

export async function runSkill(
  ctx: Context,
  options: SkillCommandOptions,
): Promise<number> {
  switch (options.subcommand) {
    case 'validate':
      return runSkillValidate(ctx, options);
    case 'new':
      return runSkillNewCommand(ctx, options);
    case 'eval':
      return runSkillEvalCommand(ctx, options);
    case 'triggers':
      return runSkillTriggersCommand(ctx, options);
    case 'report':
      return runSkillReportCommand(ctx, options);
    default:
      throw new UsageError(SKILL_USAGE);
  }
}
