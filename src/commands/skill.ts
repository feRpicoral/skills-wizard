import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { styleText } from 'node:util';

import type { Context } from '../context.ts';
import { SourceError, UsageError } from '../errors.ts';
import {
  type BenchmarkSummary,
  loadBenchmarkFromIteration,
} from '../evals/aggregate.ts';
import type { TriggerSplit } from '../evals/cases.ts';
import {
  regenerateSkillReport,
  runSkillEval,
  runSkillTriggers,
} from '../evals/engine.ts';
import { formatPassRateDelta, formatRate } from '../evals/report.ts';
import {
  createEvalRunner,
  detectDefaultRunner,
  type EvalRunner,
  type EvalRunnerName,
  parseEvalRunnerName,
} from '../evals/runners/index.ts';
import type { ComparedSkillSpec } from '../evals/workspace.ts';
import { displayPath } from '../install/describe.ts';
import { isDirectory, lstatIfExists, statIfExists } from '../install/fs.ts';
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
  const withMean = formatRate(summary.with_skill.pass_rate.mean);
  const deltas = [
    ...(summary.without_skill
      ? [
          `${formatPassRateDelta(summary.with_skill, summary.without_skill)} vs baseline`,
        ]
      : []),
    ...(summary.old_skill
      ? [
          `${formatPassRateDelta(summary.with_skill, summary.old_skill)} vs old_skill`,
        ]
      : []),
    ...Object.entries(summary.compare_skills ?? {}).map(
      ([name, variant]) =>
        `${formatPassRateDelta(summary.with_skill, variant)} vs ${name}`,
    ),
  ];
  const deltaStr = deltas.length > 0 ? ` (${deltas.join(', ')})` : '';
  ctx.print(
    `Evaluated ${metadata.skill_name} with ${metadata.runner}: with_skill pass rate ${withMean}${deltaStr}.`,
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
  const cwdSkillDir = join(ctx.cwd, 'skills', nameOrPath);
  if (isSkillName(nameOrPath) && (await isDirectory(cwdSkillDir))) {
    return { skillName: nameOrPath, skillDir: cwdSkillDir };
  }
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

interface ResolveComparedSkillParams {
  ctx: Context;
  nameOrPath: string;
}

async function tryResolveLocalComparedSkill({
  ctx,
  nameOrPath,
}: ResolveComparedSkillParams): Promise<ComparedSkillSpec | null> {
  const candidates = isSkillName(nameOrPath)
    ? [
        join(ctx.cwd, 'skills', nameOrPath),
        join(ctx.repoRoot, 'skills', nameOrPath),
        join(ctx.paths.skillsDir, nameOrPath),
      ]
    : [];
  for (const dir of candidates) {
    if ((await statIfExists(join(dir, 'SKILL.md')))?.isFile()) {
      const report = await validateSkill(dir, { strict: false });
      const skillName =
        report.name && isSkillName(report.name) ? report.name : nameOrPath;
      return { skillName, skillDir: dir };
    }
  }
  const resolved = resolve(ctx.cwd, nameOrPath);
  if ((await statIfExists(join(resolved, 'SKILL.md')))?.isFile()) {
    const report = await validateSkill(resolved, { strict: false });
    const fallbackName = basename(resolved);
    const skillName =
      report.name && isSkillName(report.name)
        ? report.name
        : isSkillName(fallbackName)
          ? fallbackName
          : undefined;
    if (!skillName) {
      throw new UsageError(
        `Compared skill directory "${nameOrPath}" does not have a valid skill name`,
      );
    }
    return { skillName, skillDir: resolved };
  }
  return null;
}

async function resolveComparedSkill({
  ctx,
  nameOrPath,
}: ResolveComparedSkillParams): Promise<ComparedSkillSpec> {
  const local = await tryResolveLocalComparedSkill({ ctx, nameOrPath });
  if (local !== null) return local;

  if (isSkillName(nameOrPath)) {
    const library = await loadSkillLibrary(ctx.repoRoot);
    const entry = library.catalog.skills.find(
      (item) => item.name === nameOrPath,
    );
    if (entry !== undefined) {
      const root = await ensureSource(sourceCache(ctx), {
        repo: entry.repo,
        ...(entry.ref ? { ref: entry.ref } : {}),
        paths: repositoryPaths(library.catalog, entry.repo),
      });
      const skillDir =
        entry.path === WHOLE_REPOSITORY ? root : join(root, entry.path);
      if ((await statIfExists(join(skillDir, 'SKILL.md')))?.isFile()) {
        return { skillName: entry.name, skillDir };
      }
    }
  }

  throw new UsageError(
    `Compared skill "${nameOrPath}" was not found in skills/, catalog.yaml, or on disk`,
  );
}

interface ResolveCompareSpecParams {
  ctx: Context;
  primarySkillName: string;
  primarySkillDir: string;
  compare: string | undefined;
  forceCompareRef: boolean;
}

interface ResolvedCompareSpec {
  compareRef?: string;
  compareSkills?: ComparedSkillSpec[];
}

async function resolveCompareSpec({
  ctx,
  primarySkillName,
  primarySkillDir,
  compare,
  forceCompareRef,
}: ResolveCompareSpecParams): Promise<ResolvedCompareSpec> {
  if (compare === undefined) return {};
  if (forceCompareRef) return { compareRef: compare };
  const primaryRealDir = await realpath(primarySkillDir);

  if (compare.includes(',')) {
    const rawItems = compare.split(',').map((item) => item.trim());
    if (rawItems.some((item) => item === '')) {
      throw new UsageError(
        '--compare skill list must not contain empty entries',
      );
    }
    const compareSkills: ComparedSkillSpec[] = [];
    const seenRealDirs = new Set<string>([primaryRealDir]);
    const seenNames = new Set<string>();
    for (const item of rawItems) {
      const resolved = await resolveComparedSkill({ ctx, nameOrPath: item });
      const realDir = await realpath(resolved.skillDir);
      if (realDir === primaryRealDir) continue;
      if (resolved.skillName === primarySkillName) {
        throw new UsageError(
          `Compared skill "${item}" has the same name "${primarySkillName}" as the skill under evaluation; use --compare <ref> to compare two revisions of the same skill`,
        );
      }
      if (seenRealDirs.has(realDir)) continue;
      if (seenNames.has(resolved.skillName)) {
        throw new UsageError(
          `Cannot compare two skills with the same name "${resolved.skillName}"`,
        );
      }
      seenRealDirs.add(realDir);
      seenNames.add(resolved.skillName);
      compareSkills.push(resolved);
    }
    if (compareSkills.length === 0) {
      throw new UsageError(
        '--compare must include at least one competing skill distinct from the skill under evaluation',
      );
    }
    return { compareSkills };
  }

  const singleLocal = await tryResolveLocalComparedSkill({
    ctx,
    nameOrPath: compare,
  });
  if (
    singleLocal !== null &&
    singleLocal.skillName !== primarySkillName &&
    (await realpath(singleLocal.skillDir)) !== primaryRealDir
  ) {
    return { compareSkills: [singleLocal] };
  }

  if (isSkillName(compare) && compare !== primarySkillName) {
    const library = await loadSkillLibrary(ctx.repoRoot);
    const entry = library.catalog.skills.find((item) => item.name === compare);
    if (entry !== undefined) {
      const catalogSkill = await resolveComparedSkill({
        ctx,
        nameOrPath: compare,
      });
      return { compareSkills: [catalogSkill] };
    }
  }

  return { compareRef: compare };
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

interface WarnUnsupportedSandboxParams {
  ctx: Context;
  runner: EvalRunner;
  sandbox: boolean;
}

/** Warns when --sandbox was requested but the runner cannot honor it. */
export function warnUnsupportedSandbox({
  ctx,
  runner,
  sandbox,
}: WarnUnsupportedSandboxParams): void {
  if (!sandbox || runner.sandboxSupported !== false) return;
  ctx.print(
    `${WARN_LABEL}  --sandbox is not supported by the ${runner.name} runner; its runs are not sandboxed and use your real home directory.`,
  );
}

interface ResolveEvalRunnerParams {
  ctx: Context;
  rawRunner: string | undefined;
  binary: string | undefined;
  sandbox: boolean;
}

async function resolveEvalRunner({
  ctx,
  rawRunner,
  binary,
  sandbox,
}: ResolveEvalRunnerParams): Promise<EvalRunner> {
  let runnerName: EvalRunnerName;
  // --binary wins over AGY_BIN, so AGY_BIN is not read (or validated) then;
  // otherwise it is read only for auto-detection and agy runs.
  const readAgyBin = () => (binary ? undefined : ctx.agy?.bin());
  let agyBin: string | undefined;
  if (rawRunner) {
    runnerName = parseEvalRunnerName(rawRunner);
    if (runnerName === 'agy') agyBin = readAgyBin();
  } else {
    agyBin = readAgyBin();
    runnerName = await detectDefaultRunner({
      searchPath: ctx.searchPath,
      ...(agyBin ? { agyConfig: { bin: agyBin, extraArgs: [] } } : {}),
    });
  }
  const agyConfig =
    runnerName === 'agy'
      ? {
          ...(agyBin ? { bin: agyBin } : {}),
          extraArgs: ctx.agy?.extraArgs() ?? [],
        }
      : undefined;
  const runner = createEvalRunner({
    runner: runnerName,
    binary,
    cwd: ctx.cwd,
    agyConfig,
    env: ctx.sources.env,
  });
  warnUnsupportedSandbox({ ctx, runner, sandbox });
  return runner;
}

interface ResolveReportDirParams {
  ctx: Context;
  args: readonly string[];
}

interface ResolvedReportDir {
  skillName?: string;
  iterationDir?: string;
}

async function resolveReportDir({
  ctx,
  args,
}: ResolveReportDirParams): Promise<ResolvedReportDir> {
  const [first, second] = args;
  if (first === undefined) return {};
  if (second === undefined) {
    const candidateDir = resolve(ctx.cwd, first);
    if ((await lstatIfExists(join(candidateDir, 'benchmark.json'))) !== null) {
      return { iterationDir: candidateDir };
    }
    if (!isSkillName(first)) {
      throw new UsageError(
        `"${first}" is neither a skill name nor a directory containing benchmark.json`,
      );
    }
    return { skillName: first };
  }
  if (!isSkillName(first)) {
    throw new UsageError(`Invalid skill name "${first}"`);
  }
  if (isAbsolute(second)) return { skillName: first, iterationDir: second };
  const fromCwd = resolve(ctx.cwd, second);
  if ((await lstatIfExists(fromCwd)) !== null) {
    return { skillName: first, iterationDir: fromCwd };
  }
  const skillEvalsDir = join(ctx.paths.evalsDir, first);
  const fromEvals = resolve(skillEvalsDir, second);
  const inside = relative(skillEvalsDir, fromEvals);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new UsageError(
      `Iteration directory "${second}" must be inside the ${first} evals directory`,
    );
  }
  return { skillName: first, iterationDir: fromEvals };
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
  name: rawName,
  template,
  withEvals,
}: RunSkillNewParams): Promise<number> {
  const name = rawName.startsWith('skills/')
    ? rawName.slice('skills/'.length)
    : rawName;
  if (!isSkillName(name)) {
    throw new UsageError(
      `Invalid skill name "${rawName}". Use lowercase alphanumeric characters and single hyphens.`,
    );
  }
  const skillDir = join(ctx.cwd, 'skills', name);
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
            prompt: `Can you run sample.txt through ${name} and save the result to output.md?`,
            expected_output: `output.md contains sample.txt processed following the ${name} instructions.`,
            files: ['evals/files/starter-case/sample.txt'],
            assertions: [
              `output.md reflects the ${name} workflow applied to the content of sample.txt`,
              { type: 'file_exists', path: 'output.md' },
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
          query: `Can you set up ${name} for this repo? I'm not sure where to start.`,
          should_trigger: true,
        },
        {
          query: 'Summarize what the last three commits in this repo changed.',
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
    forceCompareRef = false,
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
        'Usage: agents-config skill eval <name> [--runner <name>] [--runs <n>] [--baseline|--no-baseline|--baseline none|<ref>] [--compare <ref>|<skill-a>,<skill-b>] [--case <id>] [--cases <ids>] [--parallel <n>] [--timeout <s>] [--sandbox] [--keep-workdirs]',
      );
    }
    const { skillName, skillDir } = await resolveTargetSkill({
      ctx,
      nameOrPath: paths[0],
    });
    const { compareRef, compareSkills } = await resolveCompareSpec({
      ctx,
      primarySkillName: skillName,
      primarySkillDir: skillDir,
      compare,
      forceCompareRef,
    });
    const runner = await resolveEvalRunner({ ctx, rawRunner, binary, sandbox });
    const result = await runSkillEval({
      skillName,
      skillDir,
      evalsRootDir: ctx.paths.evalsDir,
      runner,
      runs: runs ?? 1,
      baseline: baseline ?? true,
      compareRef,
      compareSkills,
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
    const runner = await resolveEvalRunner({ ctx, rawRunner, binary, sandbox });
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
      paths: ctx.paths,
      env: ctx.sources.env,
      onLog: (line) => ctx.print(line),
    });
    const { metrics } = result.summary;
    const excluded =
      metrics.errored_queries > 0
        ? `, ${metrics.errored_queries}/${metrics.total_queries} queries excluded (failed runs)`
        : '';
    ctx.print(
      `Triggers for ${skillName} (${split}): recall ${formatRate(metrics.recall)}, precision ${formatRate(metrics.precision)}, false positive rate ${formatRate(metrics.false_positive_rate)}, accuracy ${formatRate(metrics.accuracy)}${excluded}.`,
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
    const target = await resolveReportDir({ ctx, args: paths });
    if (target.skillName !== undefined && target.iterationDir !== undefined) {
      const { metadata } = await loadBenchmarkFromIteration(
        target.iterationDir,
      );
      if (metadata.skill_name !== target.skillName) {
        throw new UsageError(
          `${displayPath({ path: target.iterationDir, home: ctx.paths.home })} holds a benchmark for "${metadata.skill_name}", not "${target.skillName}"`,
        );
      }
    }
    const result = await regenerateSkillReport({
      evalsRootDir: ctx.paths.evalsDir,
      ...target,
    });
    printBenchmarkSummary(ctx, result.benchmark);
    ctx.print(
      `Rendered report: ${displayPath({ path: join(result.iterationDir, 'report.md'), home: ctx.paths.home })}`,
    );
    return 0;
  }

  throw new UsageError(
    'Usage: agents-config skill validate [path...] [--catalog] | new <name> | eval <name> | triggers <name> | report <name|run-dir> [iteration-dir]',
  );
}
