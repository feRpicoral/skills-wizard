import assert from 'node:assert/strict';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { Context } from '../context.ts';
import { EnvironmentError, UsageError } from '../errors.ts';
import { createFakeRunner } from '../evals/runners/fake.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { createUpstream, isolatedGitEnv } from '../test-support/git.ts';
import { runSkill, warnUnsupportedSandbox } from './skill.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

interface TestContextOptions {
  url?: (repo: string) => string;
}

async function testContext(
  t: TestContext,
  { url }: TestContextOptions = {},
): Promise<{ ctx: Context; repoRoot: string; output: string[] }> {
  const paths = await tempPaths(t);
  const repoRoot = await tempDir(t);
  await writeFiles(repoRoot, {
    'blocks/index.yaml': [
      'headers:',
      '  global: "# Instructions"',
      'groups:',
      '  core: Core',
      'order:',
      '  - core/identity',
      '',
    ].join('\n'),
    'blocks/core/identity.md': [
      '---',
      'title: Identity',
      'summary: Core identity',
      'group: core',
      'scopes: [global, project]',
      'defaults: [global, project]',
      '---',
      '',
      'Follow the rules.',
      '',
    ].join('\n'),
    'catalog.yaml': [
      'categories:',
      '  diagrams: Diagrams',
      '  workflow: Workflow',
      'skills:',
      '  - name: pretty-mermaid',
      '    repo: owner/mermaid',
      '    path: .',
      '    category: diagrams',
      '    scopes: [global, project]',
      '    defaults: [global]',
      '',
    ].join('\n'),
  });
  const output: string[] = [];
  const ctx: Context = {
    paths,
    repoRoot,
    cwd: repoRoot,
    searchPath: [],
    interactive: false,
    sources: {
      url: url ?? (() => 'file:///nowhere.git'),
      env: isolatedGitEnv(paths.home),
      now: () => new Date('2026-01-02T03:04:05Z'),
    },
    print: (line = '') => {
      output.push(line);
    },
  };
  return { ctx, repoRoot, output };
}

test('skill validate checks paths and --catalog', async (t) => {
  const upstream = await createUpstream(t, {
    'SKILL.md': skillSource('pretty-mermaid'),
  });
  const { ctx, repoRoot, output } = await testContext(t, {
    url: () => upstream.url,
  });
  await writeFiles(repoRoot, {
    'skills/good-skill/SKILL.md': skillSource('good-skill'),
  });

  const pathCode = await runSkill(ctx, {
    subcommand: 'validate',
    paths: [join(repoRoot, 'skills', 'good-skill')],
    catalog: false,
  });
  const catalogCode = await runSkill(ctx, {
    subcommand: 'validate',
    paths: [],
    catalog: true,
  });

  assert.equal(pathCode, 0);
  assert.equal(catalogCode, 0);
  assert.match(output.join('\n'), /good-skill/);
  assert.match(output.join('\n'), /pretty-mermaid \(owner\/mermaid\)/);
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'validate',
      paths: [REPO_ROOT],
      catalog: true,
    }),
    UsageError,
  );
});

test('skill new, eval, triggers, and report scaffold and evaluate skills with the fake runner', async (t) => {
  const { ctx, repoRoot, output } = await testContext(t);

  const newCode = await runSkill(ctx, {
    subcommand: 'new',
    paths: ['demo-eval-skill'],
    template: 'scripted',
    withEvals: true,
  });
  const evalCode = await runSkill(ctx, {
    subcommand: 'eval',
    paths: ['demo-eval-skill'],
    runner: 'fake',
    runs: 1,
    baseline: true,
    cases: ['starter-case'],
  });
  const triggersCode = await runSkill(ctx, {
    subcommand: 'triggers',
    paths: ['demo-eval-skill'],
    runner: 'fake',
    split: 'all',
    runs: 1,
    threshold: 0.5,
  });
  const reportByNameCode = await runSkill(ctx, {
    subcommand: 'report',
    paths: ['demo-eval-skill'],
  });
  const reportByDirCode = await runSkill(ctx, {
    subcommand: 'report',
    paths: [join(ctx.paths.evalsDir, 'demo-eval-skill', 'iteration-1')],
  });
  const scaffoldedSkill = await readFile(
    join(repoRoot, 'skills', 'demo-eval-skill', 'SKILL.md'),
    'utf8',
  );
  const reportMd = await readFile(
    join(ctx.paths.evalsDir, 'demo-eval-skill', 'iteration-1', 'report.md'),
    'utf8',
  );

  assert.equal(newCode, 0);
  assert.equal(evalCode, 0);
  assert.equal(triggersCode, 0);
  assert.equal(reportByNameCode, 0);
  assert.equal(reportByDirCode, 0);
  assert.match(scaffoldedSkill, /name: demo-eval-skill/);
  assert.match(reportMd, /Skill Evaluation Report: `demo-eval-skill`/);
  assert.match(output.join('\n'), /Evaluated demo-eval-skill with fake/);
  assert.match(output.join('\n'), /Triggers for demo-eval-skill/);
  assert.match(output.join('\n'), /Rendered report:/);
});

test('skill report <name> <iteration-dir> resolves the iteration under that skill evals', async (t) => {
  const { ctx, output } = await testContext(t);
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['report-skill'],
    withEvals: true,
  });
  const evalOptions = {
    subcommand: 'eval' as const,
    paths: ['report-skill'],
    runner: 'fake' as const,
    baseline: false,
  };
  await runSkill(ctx, evalOptions);
  await runSkill(ctx, evalOptions);
  const skillEvals = join(ctx.paths.evalsDir, 'report-skill');
  await rm(join(skillEvals, 'iteration-1', 'report.md'));
  await rm(join(skillEvals, 'iteration-2', 'report.md'));
  output.length = 0;

  const code = await runSkill(ctx, {
    subcommand: 'report',
    paths: ['report-skill', 'iteration-1'],
  });

  assert.equal(code, 0);
  await lstat(join(skillEvals, 'iteration-1', 'report.md'));
  await assert.rejects(lstat(join(skillEvals, 'iteration-2', 'report.md')), {
    code: 'ENOENT',
  });
  assert.match(output.join('\n'), /iteration-1\/report\.md/);
});

test('skill report validates the skill name and keeps the iteration inside its evals', async (t) => {
  const { ctx } = await testContext(t);

  await assert.rejects(
    runSkill(ctx, { subcommand: 'report', paths: ['../x', 'iteration-1'] }),
    /Invalid skill name/,
  );
  await assert.rejects(
    runSkill(ctx, { subcommand: 'report', paths: ['Not A Skill'] }),
    UsageError,
  );
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'report',
      paths: ['demo', '../other/iteration-1'],
    }),
    /must be inside the demo evals directory/,
  );
});

test('skill new --with-evals asserts on the output the starter task produces', async (t) => {
  const { ctx, repoRoot } = await testContext(t);

  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['starter-skill'],
    withEvals: true,
  });
  const suite = JSON.parse(
    await readFile(
      join(repoRoot, 'skills', 'starter-skill', 'evals', 'evals.json'),
      'utf8',
    ),
  ) as { evals: { assertions: unknown[] }[] };
  const triggers = await readFile(
    join(repoRoot, 'skills', 'starter-skill', 'evals', 'trigger_queries.json'),
    'utf8',
  );

  assert.deepEqual(suite.evals[0]?.assertions.slice(1), [
    { type: 'file_exists', path: 'output.md' },
  ]);
  assert.doesNotMatch(triggers, /\[negative\]/);
});

test('--sandbox warns when the runner cannot sandbox its runs', async (t) => {
  const { ctx, output } = await testContext(t);
  const runner = {
    ...createFakeRunner(),
    name: 'claude' as const,
    sandboxSupported: false,
  };

  warnUnsupportedSandbox({ ctx, runner, sandbox: true });
  warnUnsupportedSandbox({ ctx, runner, sandbox: false });
  warnUnsupportedSandbox({ ctx, runner: createFakeRunner(), sandbox: true });

  assert.equal(output.length, 1);
  assert.match(
    output[0] ?? '',
    /--sandbox is not supported by the claude runner/,
  );
});

test('skill eval reads the agy settings only for the agy runner', async (t) => {
  const { ctx } = await testContext(t);
  let configReads = 0;
  ctx.agy = {
    bin: () => undefined,
    extraArgs: () => {
      configReads += 1;
      throw new EnvironmentError('AGY_EXTRA_ARGS must be a JSON array');
    },
  };
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['agy-skill'],
    withEvals: true,
  });

  const fakeCode = await runSkill(ctx, {
    subcommand: 'eval',
    paths: ['agy-skill'],
    runner: 'fake',
    baseline: false,
  });
  const readsAfterFake = configReads;

  assert.equal(fakeCode, 0);
  assert.equal(readsAfterFake, 0);
  await assert.rejects(
    runSkill(ctx, { subcommand: 'eval', paths: ['agy-skill'], runner: 'agy' }),
    EnvironmentError,
  );
  assert.equal(configReads, 1);
});

test('skill eval prints pass-rate deltas in percentage points', async (t) => {
  const { ctx, output } = await testContext(t);
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['summary-skill'],
    withEvals: true,
  });

  const code = await runSkill(ctx, {
    subcommand: 'eval',
    paths: ['summary-skill'],
    runner: 'fake',
    baseline: true,
  });

  assert.equal(code, 0);
  assert.match(
    output.join('\n'),
    /with_skill pass rate \d+\.\d% \([+-]\d+\.\d pp vs baseline\)/,
  );
});

test('skill triggers warns when a personal Claude skill shadows the staged one', async (t) => {
  const { ctx, output } = await testContext(t);
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['shadowed-skill'],
    withEvals: true,
  });
  await writeFiles(join(ctx.paths.claudeHome, 'skills', 'shadowed-skill'), {
    'SKILL.md': skillSource('shadowed-skill'),
  });
  const binDir = await tempDir(t);
  const binary = join(binDir, 'claude');
  await writeFile(
    binary,
    `#!/bin/sh\necho '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } })}'\n`,
  );
  await chmod(binary, 0o755);

  const code = await runSkill(ctx, {
    subcommand: 'triggers',
    paths: ['shadowed-skill'],
    runner: 'claude',
    binary,
  });
  const summary = JSON.parse(
    await readFile(
      join(ctx.paths.evalsDir, 'shadowed-skill', 'triggers-1', 'triggers.json'),
      'utf8',
    ),
  ) as { metadata: { possibly_contaminated: boolean } };

  assert.equal(code, 0);
  assert.match(output.join('\n'), /warning: .*personal skill/);
  assert.equal(summary.metadata.possibly_contaminated, true);
});

test('skill triggers reports queries excluded because every run failed', async (t) => {
  const { ctx, output } = await testContext(t);
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['failing-skill'],
    withEvals: true,
  });
  const binDir = await tempDir(t);
  const binary = join(binDir, 'claude');
  await writeFile(binary, '#!/bin/sh\necho "boom" >&2\nexit 1\n');
  await chmod(binary, 0o755);

  const code = await runSkill(ctx, {
    subcommand: 'triggers',
    paths: ['failing-skill'],
    runner: 'claude',
    binary,
  });
  const summary = JSON.parse(
    await readFile(
      join(ctx.paths.evalsDir, 'failing-skill', 'triggers-1', 'triggers.json'),
      'utf8',
    ),
  ) as { metrics: { errored_queries: number; total_queries: number } };

  assert.equal(code, 0);
  assert.ok(summary.metrics.errored_queries > 0);
  assert.match(
    output.join('\n'),
    new RegExp(
      `, ${summary.metrics.errored_queries}/${summary.metrics.total_queries} queries excluded \\(failed runs\\)\\.`,
    ),
  );
});

test('skill eval --runner agy --binary skips AGY_BIN but keeps AGY_EXTRA_ARGS', async (t) => {
  const { ctx } = await testContext(t);
  const binDir = await tempDir(t);
  const argsLog = join(binDir, 'args.log');
  const stub = join(binDir, 'agy');
  await writeFile(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argsLog}'\nexit 1\n`,
  );
  await chmod(stub, 0o755);
  ctx.agy = {
    bin: () => {
      throw new EnvironmentError('AGY_BIN must be an absolute path');
    },
    extraArgs: () => ['--from-agy-extra-args'],
  };
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['agy-binary-skill'],
    withEvals: true,
  });

  const code = await runSkill(ctx, {
    subcommand: 'eval',
    paths: ['agy-binary-skill'],
    runner: 'agy',
    binary: stub,
    baseline: false,
    timeout: 30,
  });

  assert.equal(code, 0);
  assert.match(await readFile(argsLog, 'utf8'), /^--from-agy-extra-args$/m);
});

test('skill report <name> <dir> rejects a directory that holds another skill benchmark', async (t) => {
  const { ctx } = await testContext(t);
  await runSkill(ctx, {
    subcommand: 'new',
    paths: ['first-skill'],
    withEvals: true,
  });
  await runSkill(ctx, {
    subcommand: 'eval',
    paths: ['first-skill'],
    runner: 'fake',
    baseline: false,
  });
  const iterationDir = join(ctx.paths.evalsDir, 'first-skill', 'iteration-1');
  await rm(join(iterationDir, 'report.md'));

  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'report',
      paths: ['second-skill', iterationDir],
    }),
    /holds a benchmark for "first-skill", not "second-skill"/,
  );
  await assert.rejects(lstat(join(iterationDir, 'report.md')), {
    code: 'ENOENT',
  });
  assert.equal(
    await runSkill(ctx, {
      subcommand: 'report',
      paths: ['first-skill', iterationDir],
    }),
    0,
  );
});
