import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  addRecordedBlock,
  clearRecordedVariables,
  commandSandbox,
  manifestPath,
  projectManifestPath,
  run,
} from '../test-support/command-fixtures.ts';
import {
  blockSource,
  skillSource,
  tempDir,
  writeFiles,
} from '../test-support/fixtures.ts';
import type { ToolId } from '../tools/registry.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';

test('init installs and doctor then finds no problems', async (t) => {
  const { createCtx } = await commandSandbox(t);

  const installCode = await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  const { ctx, output } = createCtx();
  const doctorCode = await runDoctor(ctx, { scope: 'global' });

  assert.equal(installCode, 0);
  assert.equal(doctorCode, 0);
  assert.match(output(), /No problems found/);
});

test('doctor warns that sync will drop blocks that left the library', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await addRecordedBlock({ file: manifestPath(home), id: 'core/removed' });

  const { ctx, output } = createCtx();
  const code = await runDoctor(ctx, { scope: 'global' });

  assert.equal(code, 0);
  assert.match(output(), /core\/removed; skills-wizard sync will drop/);
  assert.match(await readFile(manifestPath(home), 'utf8'), /core\/removed/);
});

test('doctor reports a variable a block gained without crashing', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await clearRecordedVariables(manifestPath(home));

  const { ctx, output } = createCtx();
  const code = await runDoctor(ctx, { scope: 'global' });

  assert.equal(code, 1);
  assert.match(
    output(),
    /^error\s+.*githubUsername.*skills-wizard init --global --var githubUsername=<value>/m,
  );
});

test('doctor still reports conflicts when a gained variable has no value', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await clearRecordedVariables(manifestPath(home));
  const marker = '<!-- BEGIN:skills-wizard -->';
  await writeFile(
    join(home, '.codex', 'AGENTS.md'),
    `${marker}\n${marker}\n<!-- END:skills-wizard -->\n`,
  );

  const { ctx, output } = createCtx();
  const code = await runDoctor(ctx, { scope: 'global' });

  assert.equal(code, 1);
  assert.match(output(), /^error\s+.*githubUsername.*init --global/m);
  assert.match(output(), /^error\s+~\/\.codex\/AGENTS\.md: /m);
  assert.doesNotMatch(output(), /out of date/);
});

test('doctor says sync will record a gained variable it can look up', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['codex'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await clearRecordedVariables(manifestPath(home));
  await writeFile(join(home, '.gitconfig'), '[github]\n\tuser = hubot\n');

  const { ctx, output } = createCtx();
  const code = await runDoctor(ctx, { scope: 'global' });

  assert.equal(code, 0);
  assert.match(
    output(),
    /^warn\s+.*skills-wizard sync will record githubUsername=hubot/m,
  );
  assert.doesNotMatch(output(), /init --global --var/);
});

test('doctor warns about every extra Gemini file Antigravity loads', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['antigravity'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await writeFiles(join(home, '.gemini'), {
    'GEMINI.md': 'extra\n',
    'config/AGENTS.md': 'extra\n',
    'config/GEMINI.md': 'extra\n',
  });

  const { ctx, output } = createCtx();
  await runDoctor(ctx, { scope: 'global' });

  for (const file of ['GEMINI.md', 'config/AGENTS.md', 'config/GEMINI.md']) {
    assert.match(
      output(),
      new RegExp(
        `~/\\.gemini/${file.replace('.', '\\.')} is loaded in addition`,
      ),
    );
  }
});

test('doctor warns Gemini CLI users only about ~/.gemini/GEMINI.md', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['gemini-cli'] satisfies ToolId[],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  await writeFiles(join(home, '.gemini'), {
    'GEMINI.md': 'extra\n',
    'config/AGENTS.md': 'extra\n',
    'config/GEMINI.md': 'extra\n',
  });

  const { ctx, output } = createCtx();
  await runDoctor(ctx, { scope: 'global' });

  assert.match(output(), /~\/\.gemini\/GEMINI\.md is loaded in addition/);
  assert.doesNotMatch(output(), /\.gemini\/config\//);
});

test('doctor warns that sync will drop blocks no longer available for the scope', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const project = await tempDir(t);
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await addRecordedBlock({
    file: projectManifestPath(project),
    id: 'core/identity',
  });

  const { ctx, output } = createCtx();
  const code = await runDoctor(ctx, { scope: 'project', projectDir: project });

  assert.equal(code, 0);
  assert.match(output(), /core\/identity; skills-wizard sync will drop/);
});

test('doctor names project files relative to the project', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const project = await tempDir(t);
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await writeFile(join(project, 'AGENTS.md'), 'edited\n');

  const { ctx, output } = createCtx();
  await runDoctor(ctx, { scope: 'project', projectDir: project });

  assert.match(output(), /^warn\s+AGENTS\.md is out of date/m);
});

test('doctor warns that sync will stop keeping files local once the project leaves git', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const project = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: project });
  await runInit(createCtx().ctx, {
    scope: 'project',
    projectDir: project,
    tools: ['codex'],
    variables: {},
    keepLocal: true,
    yes: true,
    dryRun: false,
  });
  await rm(join(project, '.git'), { recursive: true, force: true });

  const { ctx, output } = createCtx();
  const code = await runDoctor(ctx, { scope: 'project', projectDir: project });

  assert.equal(code, 0);
  assert.match(
    output(),
    /^warn\s+.*no longer in a git repository; skills-wizard sync will stop keeping its files local/m,
  );
  assert.doesNotMatch(output(), /another repository/);
});

test('doctor counts lines accurately when a file has no trailing newline', async (t) => {
  const { home, createCtx } = await commandSandbox(t);
  await runInit(createCtx().ctx, {
    scope: 'global',
    tools: ['claude-code'],
    skills: [],
    variables: { githubUsername: 'octocat' },
    yes: true,
    dryRun: false,
  });
  const lines = Array.from({ length: 201 }, (_, i) => `line ${i + 1}`).join(
    '\n',
  );
  await writeFile(join(home, '.claude', 'CLAUDE.md'), lines);

  const { ctx, output } = createCtx();
  await runDoctor(ctx, { scope: 'global' });

  assert.match(output(), /has 201 lines; Claude Code recommends/);
});

test('doctor still reports outdated skills when a block gained a variable with no value', async (t) => {
  const { createCtx } = await commandSandbox(t);
  const { ctx: baseCtx, output } = createCtx();
  const repoRoot = await tempDir(t);
  const ctx = { ...baseCtx, repoRoot, cwd: repoRoot };
  await writeFiles(repoRoot, {
    'skills/notes/SKILL.md': skillSource('notes'),
    'catalog.yaml': 'categories: {}\nskills: []\n',
    'blocks/index.yaml': [
      'headers:',
      '  global: "# Instructions"',
      'groups:',
      '  core: Core',
      'order:',
      '  - core/identity',
      '  - core/extra',
      '',
    ].join('\n'),
    'blocks/core/identity.md': blockSource('Follow the rules.', {
      title: 'Identity',
      summary: 'Core identity',
      group: 'core',
      defaults: ['global', 'project'],
    }),
    'blocks/core/extra.md': blockSource('## Extra\n\nExtra rules.', {
      title: 'Extra',
      summary: 'Extra block',
      group: 'core',
      scopes: ['global'],
      defaults: [],
      variables: [],
    }),
  });
  await runInit(ctx, {
    scope: 'global',
    tools: ['codex'],
    blocks: ['core/identity', 'core/extra'],
    skills: ['notes'],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await writeFiles(repoRoot, {
    'skills/notes/SKILL.md': `${skillSource('notes')}\nMore steps.\n`,
    'blocks/core/extra.md': blockSource('## Extra\n\nTeam: {{teamName}}', {
      title: 'Extra',
      summary: 'Extra block',
      group: 'core',
      scopes: ['global'],
      defaults: [],
      variables: ['teamName'],
    }),
  });

  const code = await runDoctor(ctx, { scope: 'global' });

  assert.equal(code, 1);
  const printed = output();
  assert.match(printed, /no recorded value: teamName/);
  assert.match(printed, /skills\/notes is out of date/);
  assert.doesNotMatch(printed, /AGENTS\.md is out of date/);
});
