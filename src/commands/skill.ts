import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { styleText } from 'node:util';

import type { Context } from '../context.ts';
import { SourceError, UsageError } from '../errors.ts';
import type { BenchmarkSummary } from '../evals/aggregate.ts';
import type { TriggerSplit } from '../evals/cases.ts';
import {
  regenerateSkillReport,
  runSkillEval,
  runSkillTriggers,
} from '../evals/engine.ts';
import {
  createEvalRunner,
  detectDefaultRunner,
  parseEvalRunnerName,
} from '../evals/runners/index.ts';
import { displayPath } from '../install/describe.ts';
import { isDirectory, lstatIfExists } from '../install/fs.ts';
import {
  type CatalogEntry,
  repositoryPaths,
  WHOLE_REPOSITORY,
} from '../skills/catalog.ts';
import { loadSkillLibrary } from '../skills/library.ts';
import { ensureSource } from '../skills/sources.ts';
import {
  isSkillName,
  type SkillReport,
  validateSkill,
} from '../skills/validate.ts';
import { sourceCache } from './shared.ts';

export type SkillTemplate = 'basic' | 'scripted' | 'reference-heavy';

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
  caseId?: string;
  cases?: readonly string[];
  parallel?: number;
  timeout?: number;
  sandbox?: boolean;
  keepWorkdirs?: boolean;
  split?: string;
  threshold?: number;
}

const OK_LABEL = styleText('green', 'ok   ');
const WARN_LABEL = styleText('yellow', 'warn ');
const ERROR_LABEL = styleText('red', 'error');

const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  'basic',
  'scripted',
  'reference-heavy',
];

const TRIGGER_SPLITS: readonly TriggerSplit[] = ['train', 'validation', 'all'];

function printReport(ctx: Context, label: string, report: SkillReport): void {
  if (report.errors.length === 0 && report.warnings.length === 0) {
    ctx.print(`${OK_LABEL}  ${label}`);
    return;
  }
  for (const warning of report.warnings) {
    ctx.print(`${WARN_LABEL}  ${label}: ${warning}`);
  }
  for (const error of report.errors) {
    ctx.print(`${ERROR_LABEL}  ${label}: ${error}`);
  }
}

function printBenchmarkSummary(
  ctx: Context,
  benchmark: BenchmarkSummary,
): void {
  const { metadata, run_summary: summary } = benchmark;
  const withMean = (summary.with_skill.pass_rate.mean * 100).toFixed(1);
  const deltaStr = summary.delta
    ? ` (delta vs baseline: ${summary.delta.pass_rate})`
    : summary.old_skill_delta
      ? ` (delta vs old_skill: ${summary.old_skill_delta.pass_rate})`
      : '';
  ctx.print(
    `Evaluated ${metadata.skill_name} with ${metadata.runner}: with_skill pass rate ${withMean}%${deltaStr}.`,
  );
}

async function validateCatalog(ctx: Context): Promise<SkillReport[]> {
  const library = await loadSkillLibrary(ctx.repoRoot);
  const cache = sourceCache(ctx);
  const byRepo = new Map<string, CatalogEntry[]>();
  for (const entry of library.catalog.skills) {
    byRepo.set(entry.repo, [...(byRepo.get(entry.repo) ?? []), entry]);
  }

  const reports: SkillReport[] = [];
  for (const [repo, entries] of byRepo) {
    const [first] = entries;
    if (!first) continue;
    let root: string;
    try {
      root = await ensureSource(cache, {
        repo,
        ...(first.ref ? { ref: first.ref } : {}),
        paths: repositoryPaths(library.catalog, repo),
      });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      for (const entry of entries) {
        const report: SkillReport = {
          dir: repo,
          name: entry.name,
          errors: [error.message],
          warnings: [],
        };
        printReport(ctx, `${entry.name} (${repo})`, report);
        reports.push(report);
      }
      continue;
    }

    for (const entry of entries) {
      const dir =
        entry.path === WHOLE_REPOSITORY ? root : join(root, entry.path);
      const report = await validateSkill(dir, {
        strict: false,
        expectedName: entry.name,
      });
      printReport(ctx, `${entry.name} (${repo})`, report);
      reports.push(report);
    }
  }
  return reports;
}

async function validatePaths(
  ctx: Context,
  requested: readonly string[],
): Promise<SkillReport[]> {
  const dirs =
    requested.length > 0
      ? requested.map((item) => resolve(ctx.cwd, item))
      : (await loadSkillLibrary(ctx.repoRoot)).skills.flatMap((skill) =>
          skill.origin.type === 'local' ? [skill.origin.dir] : [],
        );
  if (dirs.length === 0) {
    ctx.print(
      'No first-party skills in skills/; pass a skill directory or --catalog.',
    );
    return [];
  }

  const reports: SkillReport[] = [];
  for (const dir of dirs) {
    const report = await validateSkill(dir, { strict: true });
    const label =
      report.name ?? displayPath({ path: dir, home: ctx.paths.home });
    printReport(ctx, label, report);
    reports.push(report);
  }
  return reports;
}

interface ResolveTargetSkillParams {
  ctx: Context;
  nameOrPath: string;
}

async function resolveTargetSkill({
  ctx,
  nameOrPath,
}: ResolveTargetSkillParams): Promise<{ skillName: string; skillDir: string }> {
  const repoSkillDir = join(ctx.repoRoot, 'skills', nameOrPath);
  if (isSkillName(nameOrPath) && (await isDirectory(repoSkillDir))) {
    return { skillName: nameOrPath, skillDir: repoSkillDir };
  }
  const resolved = resolve(ctx.cwd, nameOrPath);
  if (await isDirectory(resolved)) {
    const skillName = basename(resolved);
    if (!isSkillName(skillName)) {
      throw new UsageError(
        `Skill directory name "${skillName}" is not a valid skill name`,
      );
    }
    return { skillName, skillDir: resolved };
  }
  throw new UsageError(`Skill "${nameOrPath}" was not found in skills/`);
}

function parseTemplate(value: string | undefined): SkillTemplate {
  if (value === undefined) return 'basic';
  const found = SKILL_TEMPLATES.find((item) => item === value);
  if (!found) {
    throw new UsageError(
      `--template must be one of ${SKILL_TEMPLATES.join(', ')}, got "${value}"`,
    );
  }
  return found;
}

function parseSplit(value: string | undefined): TriggerSplit {
  if (value === undefined) return 'all';
  const found = TRIGGER_SPLITS.find((item) => item === value);
  if (!found) {
    throw new UsageError(
      `--split must be one of ${TRIGGER_SPLITS.join(', ')}, got "${value}"`,
    );
  }
  return found;
}

interface RenderScaffoldSkillMdParams {
  name: string;
  template: SkillTemplate;
}

function renderScaffoldSkillMd({
  name,
  template,
}: RenderScaffoldSkillMdParams): string {
  const title = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const lines = [
    '---',
    `name: ${name}`,
    `description: Handles ${name} workflows and configuration. Use when the user asks to set up, inspect, or troubleshoot ${name}.`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Overview',
    '',
    `Follow this workflow when completing ${name} tasks.`,
    '',
    '## Workflow',
    '',
    '1. Inspect the existing project files before making changes.',
    '2. Apply the minimal, standard configuration required for the task.',
    '3. Verify the result with a deterministic check before finishing.',
  ];
  if (template === 'scripted') {
    lines.push(
      '',
      '## Helper Scripts',
      '',
      '- Run `node scripts/check.mjs` to validate the target files.',
      '- Read [references/guide.md](references/guide.md) for detailed edge cases.',
    );
  } else if (template === 'reference-heavy') {
    lines.push(
      '',
      '## References',
      '',
      '- Read [references/reference.md](references/reference.md) for configuration options.',
      '- Read [references/examples.md](references/examples.md) for canonical examples.',
    );
  }
  lines.push('');
  return lines.join('\n');
}

interface RunSkillNewParams {
  ctx: Context;
  name: string;
  template: SkillTemplate;
  withEvals: boolean;
}

async function runSkillNew({
  ctx,
  name,
  template,
  withEvals,
}: RunSkillNewParams): Promise<number> {
  if (!isSkillName(name)) {
    throw new UsageError(
      `Invalid skill name "${name}". Use lowercase alphanumeric characters and single hyphens.`,
    );
  }
  const skillDir = join(ctx.repoRoot, 'skills', name);
  if ((await lstatIfExists(skillDir)) !== null) {
    throw new UsageError(`Skill directory already exists: skills/${name}`);
  }

  const files: Record<string, string> = {
    'SKILL.md': renderScaffoldSkillMd({ name, template }),
  };

  if (template === 'scripted') {
    files['scripts/check.mjs'] = [
      '#!/usr/bin/env node',
      'process.stdout.write("ok\\n");',
      '',
    ].join('\n');
    files['references/guide.md'] = [
      `# ${name} Guide`,
      '',
      'Detailed edge-case notes and troubleshooting steps.',
      '',
    ].join('\n');
  } else if (template === 'reference-heavy') {
    files['references/reference.md'] = [
      `# ${name} Reference`,
      '',
      'Detailed option reference and constraints.',
      '',
    ].join('\n');
    files['references/examples.md'] = [
      `# ${name} Examples`,
      '',
      'Canonical examples and expected outputs.',
      '',
    ].join('\n');
  }

  if (withEvals) {
    files['evals/files/starter-case/sample.txt'] = `Sample input for ${name}\n`;
    files['evals/evals.json'] = `${JSON.stringify(
      {
        skill_name: name,
        evals: [
          {
            id: 'starter-case',
            prompt: `Apply ${name} to sample.txt and summarize what changed.`,
            expected_output: `Processed sample.txt following ${name} instructions.`,
            files: ['evals/files/starter-case/sample.txt'],
            assertions: [
              `The response explains how ${name} was applied to sample.txt`,
              { type: 'file_exists', path: 'sample.txt' },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`;
    files['evals/trigger_queries.json'] = `${JSON.stringify(
      [
        {
          query: `Please use ${name} logic to update the configuration in this repo`,
          should_trigger: true,
        },
        {
          query: `[negative] Unrelated task that should not trigger ${name}`,
          should_trigger: false,
        },
      ],
      null,
      2,
    )}\n`;
  }

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(skillDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    if (relPath.startsWith('scripts/')) {
      await chmod(fullPath, 0o755);
    }
  }

  const report = await validateSkill(skillDir, { strict: true });
  printReport(ctx, name, report);
  ctx.print(
    `Scaffolded skills/${name} (template: ${template}${withEvals ? ', with evals' : ''}).`,
  );
  return report.errors.length > 0 ? 1 : 0;
}

export async function runSkill(
  ctx: Context,
  {
    subcommand,
    paths,
    catalog = false,
    template: rawTemplate,
    withEvals = false,
    runner: rawRunner,
    binary,
    runs,
    baseline,
    compare,
    caseId,
    cases,
    parallel,
    timeout,
    sandbox = false,
    keepWorkdirs = false,
    split: rawSplit,
    threshold: rawThreshold,
  }: SkillCommandOptions,
): Promise<number> {
  if (subcommand === 'validate') {
    if (catalog && paths.length > 0) {
      throw new UsageError('Use either skill paths or --catalog, not both.');
    }
    const reports = catalog
      ? await validateCatalog(ctx)
      : await validatePaths(ctx, paths);
    if (reports.length === 0) return 0;

    const errors = reports.reduce((sum, item) => sum + item.errors.length, 0);
    const warnings = reports.reduce(
      (sum, item) => sum + item.warnings.length,
      0,
    );
    ctx.print(
      `Validated ${reports.length} skill${reports.length === 1 ? '' : 's'}: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`,
    );
    return errors > 0 ? 1 : 0;
  }

  if (subcommand === 'new') {
    if (paths.length !== 1 || !paths[0]) {
      throw new UsageError(
        'Usage: agents-config skill new <name> [--template basic|scripted|reference-heavy] [--with-evals]',
      );
    }
    const template = parseTemplate(rawTemplate);
    return runSkillNew({
      ctx,
      name: paths[0],
      template,
      withEvals,
    });
  }

  if (subcommand === 'eval') {
    if (paths.length !== 1 || !paths[0]) {
      throw new UsageError(
        'Usage: agents-config skill eval <name> [--runner <name>] [--runs <n>] [--baseline|--no-baseline|--baseline none|<ref>] [--compare <ref>] [--case <id>] [--cases <ids>] [--parallel <n>] [--timeout <s>] [--sandbox] [--keep-workdirs]',
      );
    }
    const { skillName, skillDir } = await resolveTargetSkill({
      ctx,
      nameOrPath: paths[0],
    });
    const runnerName = rawRunner
      ? parseEvalRunnerName(rawRunner)
      : await detectDefaultRunner({
          searchPath: ctx.searchPath,
          agyConfig: ctx.agy,
        });
    const runner = createEvalRunner({
      runner: runnerName,
      binary,
      agyConfig: ctx.agy,
      env: ctx.sources.env,
    });
    const result = await runSkillEval({
      skillName,
      skillDir,
      repoRoot: ctx.repoRoot,
      evalsRootDir: ctx.paths.evalsDir,
      runner,
      runs: runs ?? 1,
      baseline: baseline ?? true,
      compareRef: compare,
      caseId,
      caseIds: cases,
      parallel: parallel ?? 2,
      timeoutSeconds: timeout ?? 600,
      sandbox,
      keepWorkdirs,
      paths: ctx.paths,
      env: ctx.sources.env,
      onLog: (line) => ctx.print(line),
    });
    printBenchmarkSummary(ctx, result.benchmark);
    ctx.print(
      `Report: ${displayPath({ path: join(result.iterationDir, 'report.md'), home: ctx.paths.home })}`,
    );
    return 0;
  }

  if (subcommand === 'triggers') {
    if (paths.length !== 1 || !paths[0]) {
      throw new UsageError(
        'Usage: agents-config skill triggers <name> [--runner <name>] [--split train|validation|all] [--runs <n>] [--threshold <0..1>] [--parallel <n>] [--timeout <s>] [--sandbox] [--keep-workdirs]',
      );
    }
    const { skillName, skillDir } = await resolveTargetSkill({
      ctx,
      nameOrPath: paths[0],
    });
    const split = parseSplit(rawSplit);
    const threshold = rawThreshold ?? 0.5;
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      throw new UsageError('--threshold must be a number between 0 and 1');
    }
    const runnerName = rawRunner
      ? parseEvalRunnerName(rawRunner)
      : await detectDefaultRunner({
          searchPath: ctx.searchPath,
          agyConfig: ctx.agy,
        });
    const runner = createEvalRunner({
      runner: runnerName,
      binary,
      agyConfig: ctx.agy,
      env: ctx.sources.env,
    });
    const result = await runSkillTriggers({
      skillName,
      skillDir,
      evalsRootDir: ctx.paths.evalsDir,
      runner,
      split,
      runs: runs ?? 1,
      threshold,
      parallel: parallel ?? 2,
      timeoutSeconds: timeout ?? 120,
      sandbox,
      keepWorkdirs,
      env: ctx.sources.env,
      onLog: (line) => ctx.print(line),
    });
    const { metrics } = result.summary;
    ctx.print(
      `Triggers for ${skillName} (${split}): recall ${(metrics.recall * 100).toFixed(1)}%, precision ${(metrics.precision * 100).toFixed(1)}%, false positive rate ${(metrics.false_positive_rate * 100).toFixed(1)}%, accuracy ${(metrics.accuracy * 100).toFixed(1)}%.`,
    );
    ctx.print(
      `Report: ${displayPath({ path: join(result.outputDir, 'triggers.md'), home: ctx.paths.home })}`,
    );
    return 0;
  }

  if (subcommand === 'report') {
    if (paths.length < 1 || paths.length > 2 || !paths[0]) {
      throw new UsageError(
        'Usage: agents-config skill report <name|run-dir> [iteration-dir]',
      );
    }
    const firstArg = paths[0];
    const candidateDir = resolve(ctx.cwd, firstArg);
    const isDirectRunDir =
      paths.length === 1 &&
      (await lstatIfExists(join(candidateDir, 'benchmark.json'))) !== null;
    const iterationDir = isDirectRunDir
      ? candidateDir
      : paths[1]
        ? resolve(ctx.cwd, paths[1])
        : undefined;
    const result = await regenerateSkillReport({
      evalsRootDir: ctx.paths.evalsDir,
      ...(isDirectRunDir ? {} : { skillName: firstArg }),
      iterationDir,
    });
    printBenchmarkSummary(ctx, result.benchmark);
    ctx.print(
      `Rendered report: ${displayPath({ path: join(result.iterationDir, 'report.md'), home: ctx.paths.home })}`,
    );
    return 0;
  }

  throw new UsageError(
    'Usage: agents-config skill validate [path...] [--catalog] | new <name> | eval <name> | triggers <name> | report <name>',
  );
}
