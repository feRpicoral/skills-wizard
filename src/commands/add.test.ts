import assert from 'node:assert/strict';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import type { Context } from '../context.ts';
import { CatalogError, EvalError, UsageError } from '../errors.ts';
import { lstatIfExists } from '../install/fs.ts';
import { loadCatalog } from '../skills/catalog.ts';
import { AWESOME_INDEX_FILE, searchCandidates } from '../skills/discover.ts';
import { ensureSource } from '../skills/sources.ts';
import { globalManifestPath, readManifest } from '../state/manifest.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import { createUpstream, isolatedGitEnv } from '../test-support/git.ts';
import { runAdd } from './add.ts';
import { runInit } from './init.ts';
import { runSkill } from './skill.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

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
    'mcp/servers.yaml': 'servers: []\n',
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

test('runAdd validates and scans risks, honors --dry-run, appends to catalog.yaml with --yes, and rejects duplicates', async (t) => {
  const upstream = await createUpstream(t, {
    'skills/query-advisor/SKILL.md': `${skillSource('query-advisor', {
      license: 'MIT',
    })}\nRun \`npx --yes create-db@latest\`.\n`,
  });
  const { ctx, repoRoot, output } = await testContext(t, {
    url: () => upstream.url,
  });
  await writeFiles(repoRoot, {
    'skills/local-only/SKILL.md': skillSource('local-only'),
  });
  const catalogBefore = await readFile(join(repoRoot, 'catalog.yaml'), 'utf8');

  const dryRunCode = await runAdd(ctx, {
    target: 'https://github.com/owner/db-skills/tree/main/skills/query-advisor',
    category: 'database',
    yes: false,
    dryRun: true,
  });
  const afterDryRun = await readFile(join(repoRoot, 'catalog.yaml'), 'utf8');
  const applyCode = await runAdd(ctx, {
    target: 'owner/db-skills@query-advisor',
    category: 'database',
    yes: true,
    dryRun: false,
  });
  const catalog = await loadCatalog(join(repoRoot, 'catalog.yaml'));

  assert.equal(dryRunCode, 0);
  assert.equal(afterDryRun, catalogBefore);
  assert.equal(applyCode, 0);
  assert.match(output.join('\n'), /Skill: query-advisor/);
  assert.match(output.join('\n'), /License: MIT/);
  assert.match(output.join('\n'), /runs npx with --yes/);
  assert.ok(
    catalog.skills.some(
      (entry) =>
        entry.name === 'query-advisor' &&
        entry.repo === 'owner/db-skills' &&
        entry.path === 'skills/query-advisor' &&
        entry.category === 'database',
    ),
  );
  await assert.rejects(
    runAdd(ctx, {
      target: 'owner/db-skills@query-advisor',
      yes: true,
      dryRun: false,
    }),
    CatalogError,
  );
  await assert.rejects(
    runAdd(ctx, {
      target: 'https://github.com/owner/db-skills/tree/v2/skills/other',
      yes: true,
      dryRun: false,
    }),
    CatalogError,
  );
});

test('runAdd searches skills.sh and awesome index and installs the skill when --install is set', async (t) => {
  const skillUpstream = await createUpstream(t, {
    'packages/tanstack/SKILL.md': skillSource('tanstack-query', {
      license: 'MIT',
    }),
  });
  const awesomeUpstream = await createUpstream(t, {
    [AWESOME_INDEX_FILE]: JSON.stringify([
      {
        id: 'awesome-linter',
        path: 'skills/awesome-linter',
        category: 'workflow',
        name: 'awesome-linter',
        description: 'Lint rules from awesome index',
        risk: 'low',
      },
    ]),
    'skills/awesome-linter/SKILL.md': skillSource('awesome-linter'),
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        skills: [
          {
            id: '1',
            skillId: 'tanstack-query',
            name: 'tanstack-query',
            installs: 850,
            source: 'tanstack/agent-skills',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const { ctx, repoRoot } = await testContext(t, {
    url: (repo) =>
      repo === 'tanstack/agent-skills'
        ? skillUpstream.url
        : awesomeUpstream.url,
  });
  ctx.discovery = { skillsShUrl: `http://127.0.0.1:${port}` };
  await runInit(ctx, {
    scope: 'global',
    tools: ['claude-code'],
    blocks: ['core/identity'],
    skills: [],
    variables: {},
    yes: true,
    dryRun: false,
  });

  const skillsShCode = await runAdd(ctx, {
    target: 'tanstack query',
    source: 'skills-sh',
    install: true,
    yes: true,
    dryRun: false,
  });
  const awesomeCode = await runAdd(ctx, {
    target: 'awesome linter',
    source: 'awesome',
    yes: true,
    dryRun: false,
  });
  const catalog = await loadCatalog(join(repoRoot, 'catalog.yaml'));

  assert.equal(skillsShCode, 0);
  assert.equal(awesomeCode, 0);
  assert.ok(
    (
      await lstat(join(ctx.paths.skillsDir, 'tanstack-query', 'SKILL.md'))
    ).isFile(),
  );
  assert.ok(
    (
      await lstat(join(ctx.paths.claudeHome, 'skills', 'tanstack-query'))
    ).isSymbolicLink(),
  );
  assert.ok(catalog.skills.some((entry) => entry.name === 'tanstack-query'));
  assert.ok(catalog.skills.some((entry) => entry.name === 'awesome-linter'));
});

test('skill eval --compare <skill-a>,<skill-b> evaluates competing skills side by side and prints deltas', async (t) => {
  const setupUpstream = await createUpstream(t, {
    'skills/catalog-rival/SKILL.md': skillSource('catalog-rival'),
    'skills/catalog-rival/setup.sh': '#!/bin/sh\necho ready > built.txt\n',
  });
  const { ctx, repoRoot, output } = await testContext(t, {
    url: () => setupUpstream.url,
  });
  await writeFile(
    join(repoRoot, 'catalog.yaml'),
    [
      'categories:',
      '  workflow: Workflow',
      'skills:',
      '  - name: catalog-rival',
      '    repo: owner/catalog-rival',
      '    path: skills/catalog-rival',
      '    category: workflow',
      '    scopes: [global, project]',
      '    defaults: []',
      '    setup: sh setup.sh',
      '',
    ].join('\n'),
  );
  await writeFiles(join(repoRoot, 'skills', 'primary-skill'), {
    'SKILL.md': skillSource('primary-skill'),
    'evals/evals.json': JSON.stringify({
      skill_name: 'primary-skill',
      evals: [
        {
          id: 'case-1',
          prompt: 'Configure the project',
          expected_output: 'Configured project',
          assertions: ['The output confirms skill execution'],
        },
      ],
    }),
  });
  await writeFiles(join(repoRoot, 'skills', 'rival-skill'), {
    'SKILL.md': skillSource('rival-skill'),
  });

  const code = await runSkill(ctx, {
    subcommand: 'eval',
    paths: ['primary-skill'],
    runner: 'fake',
    compare: 'rival-skill,catalog-rival',
    keepWorkdirs: true,
  });
  const catalogBuilt = await readFile(
    join(
      ctx.paths.evalsDir,
      'primary-skill',
      'iteration-1',
      'eval-case-1',
      'compare-catalog-rival',
      'run-1',
      'workdir',
      '.agents',
      'skills',
      'catalog-rival',
      'built.txt',
    ),
    'utf8',
  );

  assert.equal(code, 0);
  assert.equal(catalogBuilt.trim(), 'ready');
  assert.ok(
    output.some(
      (line) =>
        line.includes('Evaluated primary-skill with fake') &&
        line.includes('vs baseline') &&
        line.includes('vs rival-skill') &&
        line.includes('vs catalog-rival'),
    ),
  );
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'eval',
      paths: ['primary-skill'],
      runner: 'fake',
      compare: 'primary-skill,',
    }),
    UsageError,
  );
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'eval',
      paths: ['primary-skill'],
      runner: 'fake',
      compare: 'primary-skill',
    }),
    (error: unknown) =>
      error instanceof UsageError &&
      /Cannot compare skill "primary-skill" against itself/.test(error.message),
  );
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'eval',
      paths: ['primary-skill'],
      runner: 'fake',
      compare: 'rival-skill,rival-skill',
    }),
    (error: unknown) =>
      error instanceof UsageError &&
      /Duplicate compared skill "rival-skill"/.test(error.message),
  );
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'eval',
      paths: ['primary-skill'],
      runner: 'fake',
      compare: './missing-skill-dir',
    }),
    (error: unknown) =>
      error instanceof UsageError &&
      /Compared skill "\.\/missing-skill-dir" was not found in skills\/, catalog\.yaml, or on disk/.test(
        error.message,
      ),
  );
  await assert.rejects(
    runSkill(ctx, {
      subcommand: 'eval',
      paths: [join(REPO_ROOT, 'skills', 'skill-author')],
      runner: 'fake',
      compare: 'mistyped-skill-name',
    }),
    (error: unknown) =>
      error instanceof EvalError &&
      /was not found as a skill in skills\/, catalog\.yaml, or on disk, and git ref "mistyped-skill-name" does not name a commit/.test(
        error.message,
      ),
  );
});

test('runAdd with --source all filters skills marked offensive or mismatched category in awesome index and --source awesome ignores invalid SKILLS_SH_URL', async (t) => {
  const awesomeUpstream = await createUpstream(t, {
    [AWESOME_INDEX_FILE]: JSON.stringify([
      {
        id: 'red-team-exploit',
        path: 'skills/red-team-exploit',
        category: 'offensive',
        name: 'red-team-exploit',
        description: 'Pentest toolkit',
        risk: 'offensive',
      },
      {
        id: 'safe-defender',
        path: 'skills/safe-defender',
        category: 'security',
        name: 'safe-defender',
        description: 'Defensive security hardening skill',
        risk: 'low',
      },
    ]),
    'skills/safe-defender/SKILL.md': skillSource('safe-defender'),
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        skills: [
          {
            id: '1',
            skillId: 'red-team-exploit',
            name: 'red-team-exploit',
            installs: 9000,
            source: 'external-owner/exploit-mirror',
          },
          {
            id: '2',
            skillId: 'unindexed-skill',
            name: 'unindexed-skill',
            installs: 5000,
            source: 'external-owner/unindexed-repo',
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const { ctx, repoRoot } = await testContext(t, {
    url: () => awesomeUpstream.url,
  });
  ctx.discovery = {
    skillsShUrl: () => {
      throw new Error('SKILLS_SH_URL should not be read for --source awesome');
    },
  };
  const awesomeDryRunCode = await runAdd(ctx, {
    target: 'security',
    source: 'awesome',
    yes: false,
    dryRun: true,
  });
  const awesomeCacheAfterDryRun = await lstatIfExists(
    join(ctx.paths.sourcesDir, 'sickn33', 'agentic-awesome-skills'),
  );
  ctx.discovery = { skillsShUrl: `http://127.0.0.1:${port}` };
  const allCandidatesWithoutCategory = await searchCandidates({
    cache: { root: ctx.paths.sourcesDir, ...ctx.sources },
    catalog: await loadCatalog(join(repoRoot, 'catalog.yaml')),
    query: 'security',
    source: 'all',
    includeOffensive: false,
    skillsShUrl: `http://127.0.0.1:${port}`,
  });
  const allCode = await runAdd(ctx, {
    target: 'security',
    source: 'all',
    category: 'security',
    yes: true,
    dryRun: false,
  });
  const catalog = await loadCatalog(join(repoRoot, 'catalog.yaml'));

  assert.equal(allCode, 0);
  assert.equal(awesomeDryRunCode, 0);
  assert.equal(awesomeCacheAfterDryRun, null);
  assert.deepEqual(
    allCandidatesWithoutCategory.map((item) => item.name),
    ['unindexed-skill', 'safe-defender'],
  );
  assert.ok(catalog.skills.some((entry) => entry.name === 'safe-defender'));
  assert.ok(!catalog.skills.some((entry) => entry.name === 'red-team-exploit'));
  assert.ok(!catalog.skills.some((entry) => entry.name === 'unindexed-skill'));
});

test('runAdd --install requires an existing install and rolls back catalog.yaml when the skill install conflicts', async (t) => {
  const upstream = await createUpstream(t, {
    'skills/conflict-skill/SKILL.md': skillSource('conflict-skill'),
  });
  const { ctx, repoRoot } = await testContext(t, {
    url: () => upstream.url,
  });
  const catalogBefore = await readFile(join(repoRoot, 'catalog.yaml'), 'utf8');
  await assert.rejects(
    runAdd(ctx, {
      target: 'owner/conflict-repo@conflict-skill',
      install: true,
      yes: true,
      dryRun: false,
    }),
    (error: unknown) =>
      error instanceof UsageError &&
      /Nothing recorded at .* run skills-wizard init --global first/.test(
        error.message,
      ),
  );
  await runInit(ctx, {
    scope: 'global',
    tools: ['claude-code'],
    blocks: ['core/identity'],
    skills: [],
    variables: {},
    yes: true,
    dryRun: false,
  });
  await writeFiles(join(ctx.paths.skillsDir, 'conflict-skill'), {
    'SKILL.md': skillSource('conflict-skill'),
  });

  const conflictCode = await runAdd(ctx, {
    target: 'owner/conflict-repo@conflict-skill',
    install: true,
    yes: true,
    dryRun: false,
  });
  const catalogAfter = await readFile(join(repoRoot, 'catalog.yaml'), 'utf8');
  const manifest = await readManifest(globalManifestPath(ctx.paths));

  assert.equal(conflictCode, 1);
  assert.equal(catalogAfter, catalogBefore);
  assert.deepEqual(manifest?.skills, []);
});

test('runAdd --dry-run restores the sparse-checkout cone (or removes newly cloned checkouts) and GitHub default-branch URLs match unpinned catalog repos', async (t) => {
  const upstream = await createUpstream(t, {
    'skills/first-skill/SKILL.md': skillSource('first-skill'),
    'skills/second-skill/SKILL.md': skillSource('second-skill'),
  });
  const { ctx, repoRoot } = await testContext(t, {
    url: () => upstream.url,
  });
  const uncachedDryRunCode = await runAdd(ctx, {
    target: 'owner/fresh-repo@first-skill',
    yes: false,
    dryRun: true,
  });
  const uncachedCheckoutAfterDryRun = await lstatIfExists(
    join(ctx.paths.sourcesDir, 'owner', 'fresh-repo'),
  );
  await writeFile(
    join(repoRoot, 'catalog.yaml'),
    [
      'categories:',
      '  workflow: Workflow',
      'skills:',
      '  - name: first-skill',
      '    repo: owner/multi-skills',
      '    path: skills/first-skill',
      '    category: workflow',
      '    scopes: [global, project]',
      '    defaults: []',
      '',
    ].join('\n'),
  );
  const cachedRoot = await ensureSource(
    { root: ctx.paths.sourcesDir, ...ctx.sources },
    {
      repo: 'owner/multi-skills',
      paths: ['skills/first-skill'],
    },
  );

  const dryRunCode = await runAdd(ctx, {
    target:
      'https://github.com/owner/multi-skills/tree/main/skills/second-skill',
    yes: false,
    dryRun: true,
  });
  const secondAfterDryRun = await lstatIfExists(
    join(cachedRoot, 'skills', 'second-skill'),
  );
  const addCode = await runAdd(ctx, {
    target:
      'https://github.com/owner/multi-skills/tree/main/skills/second-skill',
    yes: true,
    dryRun: false,
  });
  const catalog = await loadCatalog(join(repoRoot, 'catalog.yaml'));
  const addedEntry = catalog.skills.find(
    (entry) => entry.name === 'second-skill',
  );

  assert.equal(uncachedDryRunCode, 0);
  assert.equal(uncachedCheckoutAfterDryRun, null);
  assert.equal(dryRunCode, 0);
  assert.equal(secondAfterDryRun, null);
  assert.equal(addCode, 0);
  assert.equal(addedEntry?.repo, 'owner/multi-skills');
  assert.equal(addedEntry?.ref, undefined);
});
