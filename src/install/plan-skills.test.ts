import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import type { BlockLibrary } from '../blocks/library.ts';
import type { Paths } from '../env.ts';
import type { SkillSource } from '../skills/install.ts';
import { hashTree } from '../skills/tree.ts';
import {
  globalManifestPath,
  type Manifest,
  MANIFEST_VERSION,
  projectManifestPath,
  readManifest,
  readProjectManifest,
} from '../state/manifest.ts';
import {
  skillSource,
  tempDir,
  tempPaths,
  writeFiles,
} from '../test-support/fixtures.ts';
import type { ToolId } from '../tools/registry.ts';
import { applyPlan } from './apply.ts';
import {
  buildPlan,
  type Plan,
  type ProjectContext,
  type Selection,
} from './plan.ts';

const run = promisify(execFile);
const REPO = '/repo';

const library: BlockLibrary = {
  headers: { global: '# Rules' },
  groups: {},
  blocks: [],
};

function selection(
  tools: ToolId[],
  skills: string[],
  overrides: Partial<Selection> = {},
): Selection {
  return {
    tools,
    blocks: [],
    skills,
    variables: {},
    linkCommand: false,
    keepLocal: false,
    skillMode: 'copy',
    ...overrides,
  };
}

interface LocalSkillOptions {
  root: string;
  name: string;
  files?: Record<string, string>;
}

async function localSkill({
  root,
  name,
  files = {},
}: LocalSkillOptions): Promise<SkillSource> {
  const dir = join(root, 'skills', name);
  await writeFiles(dir, { 'SKILL.md': skillSource(name), ...files });
  return {
    dir,
    record: { type: 'local', path: `skills/${name}` },
    linkable: true,
  };
}

function sources(...skills: SkillSource[]): Map<string, SkillSource> {
  return new Map(skills.map((skill) => [basename(skill.dir), skill]));
}

interface GlobalRun {
  tools: ToolId[];
  skills: SkillSource[];
  selected?: string[];
  overrides?: Partial<Selection>;
  adopt?: { names: Set<string>; backupDir: string };
}

async function installGlobal(
  paths: Paths,
  { tools, skills, selected, overrides, adopt }: GlobalRun,
) {
  const manifestPath = globalManifestPath(paths);
  const map = sources(...skills);
  const plan = await buildPlan({
    scope: 'global',
    selection: selection(tools, selected ?? [...map.keys()], overrides),
    library,
    paths,
    repoRoot: REPO,
    previous: await readManifest(manifestPath),
    manifestPath,
    skillSources: map,
    ...(adopt ? { adopt } : {}),
  });
  const outcome = await applyPlan(plan);
  return { plan, outcome };
}

interface InstallProjectParams {
  paths: Paths;
  project: ProjectContext;
  tools: ToolId[];
  skills: SkillSource[];
  overrides?: Partial<Selection>;
}

async function installProject({
  paths,
  project,
  tools,
  skills,
  overrides = {},
}: InstallProjectParams) {
  const manifestPath = projectManifestPath(project.dir);
  const stored = await readProjectManifest(manifestPath, {
    dir: project.dir,
    ...(project.git ? { gitExcludePath: project.git.excludePath } : {}),
  });
  const map = sources(...skills);
  const plan = await buildPlan({
    scope: 'project',
    selection: selection(tools, [...map.keys()], overrides),
    library,
    paths,
    repoRoot: REPO,
    previous: stored?.manifest ?? null,
    manifestPath,
    project,
    skillSources: map,
  });
  await applyPlan(plan);
  return plan;
}

function statuses({ actions }: Plan) {
  return Object.fromEntries(
    actions.map((action) => [action.path, action.status]),
  );
}

async function manifestOf(paths: Paths): Promise<Manifest | null> {
  return readManifest(globalManifestPath(paths));
}

test('a global install copies the skill once and links it for tools that need links', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });

  await installGlobal(paths, {
    tools: ['claude-code', 'antigravity', 'codex'],
    skills: [skill],
  });

  const canonical = join(paths.skillsDir, 'notes');
  assert.ok((await stat(join(canonical, 'SKILL.md'))).isFile());
  assert.equal(
    await readlink(join(paths.claudeHome, 'skills', 'notes')),
    canonical,
  );
  assert.equal(
    await readlink(join(paths.geminiHome, 'config', 'skills', 'notes')),
    canonical,
  );
  await assert.rejects(lstat(join(paths.codexHome, 'skills')), {
    code: 'ENOENT',
  });
});

test('the manifest records where a skill came from and the hash of the copy', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });

  await installGlobal(paths, { tools: ['codex'], skills: [skill] });

  const manifest = await manifestOf(paths);
  const entry = manifest?.entries.find((item) => item.kind === 'skill');
  assert.deepEqual(manifest?.skills, ['notes']);
  assert.ok(entry?.kind === 'skill' && entry.install.mode === 'copy');
  assert.match(entry.install.hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(entry.source, { type: 'local', path: 'skills/notes' });
});

test('a second install with the same source plans no changes', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, { tools: ['claude-code'], skills: [skill] });

  const { plan } = await installGlobal(paths, {
    tools: ['claude-code'],
    skills: [skill],
  });

  assert.ok(plan.actions.every((action) => action.status === 'unchanged'));
  assert.equal(plan.manifestStatus, 'unchanged');
});

test('a changed source updates the installed copy', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skill = await localSkill({ root, name: 'notes' });
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  await writeFiles(skill.dir, { 'references/new.md': 'new\n' });

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
  });

  assert.equal(statuses(plan)[join(paths.skillsDir, 'notes')], 'update');
  assert.equal(
    await readFile(
      join(paths.skillsDir, 'notes', 'references', 'new.md'),
      'utf8',
    ),
    'new\n',
  );
});

test('a skill folder agents-config does not own is a conflict and stays untouched', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await writeFiles(paths.skillsDir, { 'notes/SKILL.md': 'mine\n' });

  const { plan } = await installGlobal(paths, {
    tools: ['claude-code'],
    skills: [skill],
  });

  const canonical = plan.actions.find(
    (action) => action.path === join(paths.skillsDir, 'notes'),
  );
  assert.equal(canonical?.status, 'conflict');
  assert.match(canonical?.reason ?? '', /run agents-config adopt notes/);
  assert.equal(
    statuses(plan)[join(paths.claudeHome, 'skills', 'notes')],
    'conflict',
  );
  assert.equal(
    await readFile(join(paths.skillsDir, 'notes', 'SKILL.md'), 'utf8'),
    'mine\n',
  );
  await assert.rejects(lstat(join(paths.claudeHome, 'skills', 'notes')), {
    code: 'ENOENT',
  });
});

test('a link that already points at an unmanaged skill folder is not taken over', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await writeFiles(paths.skillsDir, { 'notes/SKILL.md': 'mine\n' });
  await mkdir(join(paths.claudeHome, 'skills'), { recursive: true });
  await symlink(
    join(paths.skillsDir, 'notes'),
    join(paths.claudeHome, 'skills', 'notes'),
  );

  await installGlobal(paths, { tools: ['claude-code'], skills: [skill] });

  const manifest = await manifestOf(paths);
  assert.deepEqual(
    manifest?.entries.filter((entry) => entry.kind === 'symlink'),
    [],
  );
});

test('a copy edited after install is a conflict and is not overwritten', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const skill = await localSkill({ root, name: 'notes' });
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  await writeFiles(paths.skillsDir, { 'notes/SKILL.md': 'edited\n' });
  await writeFiles(skill.dir, { 'references/new.md': 'new\n' });

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
  });

  const canonical = plan.actions.find(
    (action) => action.path === join(paths.skillsDir, 'notes'),
  );
  assert.equal(canonical?.status, 'conflict');
  assert.equal(
    canonical?.reason,
    'changed outside agents-config, left in place',
  );
  assert.equal(
    await readFile(join(paths.skillsDir, 'notes', 'SKILL.md'), 'utf8'),
    'edited\n',
  );
});

test('adopting backs up the unmanaged folder and links before replacing them', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await writeFiles(paths.home, {
    '.agents/skills/notes/SKILL.md': 'mine\n',
    '.claude/skills/notes/SKILL.md': 'old copy\n',
  });
  const backupDir = join(paths.stateDir, 'backups', '2026-01-01T00-00-00Z');

  const { plan } = await installGlobal(paths, {
    tools: ['claude-code'],
    skills: [skill],
    adopt: { names: new Set(['notes']), backupDir },
  });

  assert.deepEqual(
    plan.actions.map((action) => action.status),
    ['create', 'update', 'update'],
  );
  assert.equal(
    await readFile(join(backupDir, '.agents/skills/notes/SKILL.md'), 'utf8'),
    'mine\n',
  );
  assert.equal(
    await readFile(join(backupDir, '.claude/skills/notes/SKILL.md'), 'utf8'),
    'old copy\n',
  );
  assert.equal(
    await readlink(join(paths.claudeHome, 'skills', 'notes')),
    join(paths.skillsDir, 'notes'),
  );
});

test('deselecting a skill removes the copy and its links', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, {
    tools: ['claude-code', 'antigravity-cli'],
    skills: [skill],
  });

  await installGlobal(paths, {
    tools: ['claude-code', 'antigravity-cli'],
    skills: [skill],
    selected: [],
  });

  await assert.rejects(lstat(join(paths.skillsDir, 'notes')), {
    code: 'ENOENT',
  });
  await assert.rejects(lstat(join(paths.claudeHome, 'skills', 'notes')), {
    code: 'ENOENT',
  });
  await assert.rejects(
    lstat(join(paths.geminiHome, 'antigravity-cli', 'skills', 'notes')),
    { code: 'ENOENT' },
  );
  assert.deepEqual(
    (await manifestOf(paths))?.entries.filter(
      (entry) => entry.kind === 'skill' || entry.kind === 'symlink',
    ),
    [],
  );
});

test('deselecting a skill whose copy was edited leaves the copy in place', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  await writeFiles(paths.skillsDir, { 'notes/extra.md': 'mine\n' });

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    selected: [],
  });

  assert.equal(statuses(plan)[join(paths.skillsDir, 'notes')], 'unchanged');
  assert.equal(
    await readFile(join(paths.skillsDir, 'notes', 'extra.md'), 'utf8'),
    'mine\n',
  );
});

test('an unavailable source keeps the installed skill and its links', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, { tools: ['claude-code'], skills: [skill] });

  const { plan } = await installGlobal(paths, {
    tools: ['claude-code'],
    skills: [],
    selected: ['notes'],
  });

  assert.equal(
    plan.actions.find(
      (action) => action.path === join(paths.skillsDir, 'notes'),
    )?.reason,
    'source unavailable, left as it is',
  );
  assert.ok(
    (
      await stat(join(paths.claudeHome, 'skills', 'notes', 'SKILL.md'))
    ).isFile(),
  );
});

test('link mode links first-party skills to their source and copy mode replaces the link', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    overrides: { skillMode: 'link' },
  });
  const linked = await readlink(join(paths.skillsDir, 'notes'));

  await installGlobal(paths, { tools: ['codex'], skills: [skill] });

  assert.equal(linked, skill.dir);
  assert.ok((await lstat(join(paths.skillsDir, 'notes'))).isDirectory());
});

test('link mode still copies third-party skills', async (t) => {
  const paths = await tempPaths(t);
  const skill: SkillSource = {
    ...(await localSkill({ root: await tempDir(t), name: 'notes' })),
    linkable: false,
  };

  await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    overrides: { skillMode: 'link' },
  });

  assert.ok((await lstat(join(paths.skillsDir, 'notes'))).isDirectory());
});

test('setup runs in the installed copy and a failure is reported without stopping the install', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  const ready: SkillSource = {
    ...(await localSkill({ root, name: 'ready' })),
    setup: 'echo done > setup.log',
  };
  const broken: SkillSource = {
    ...(await localSkill({ root, name: 'broken' })),
    setup: 'echo missing tool >&2; exit 3',
  };

  const { plan, outcome } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [broken, ready],
  });

  assert.match(
    plan.actions.find((action) => action.path.endsWith('ready'))?.label ?? '',
    /then runs "echo done > setup.log"/,
  );
  assert.equal(
    await readFile(join(paths.skillsDir, 'ready', 'setup.log'), 'utf8'),
    'done\n',
  );
  assert.deepEqual(outcome.setupFailures, [
    {
      path: join(paths.skillsDir, 'broken'),
      message: '"echo missing tool >&2; exit 3" failed: missing tool',
    },
  ]);
});

test('a project install copies skills and links them relatively for Claude Code', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });

  await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
    skills: [skill],
  });

  const link = join(dir, '.claude', 'skills', 'notes');
  assert.equal(await readlink(link), '../../.agents/skills/notes');
  assert.equal(
    resolve(dirname(link), await readlink(link)),
    join(dir, '.agents', 'skills', 'notes'),
  );
  assert.ok((await stat(join(link, 'SKILL.md'))).isFile());
  assert.match(
    await readFile(projectManifestPath(dir), 'utf8'),
    /"path": "\.agents\/skills\/notes"/,
  );
});

test('a project never copies skills through a skills folder linked outside it', async (t) => {
  const paths = await tempPaths(t);
  const outside = await realpath(await tempDir(t));
  const dir = await realpath(await tempDir(t));
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await mkdir(join(dir, '.agents'));
  await symlink(outside, join(dir, '.agents', 'skills'));
  await mkdir(join(dir, '.claude'));
  await symlink(outside, join(dir, '.claude', 'skills'));

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
    skills: [skill],
  });

  assert.equal(
    statuses(plan)[join(dir, '.agents', 'skills', 'notes')],
    'conflict',
  );
  assert.equal(
    statuses(plan)[join(dir, '.claude', 'skills', 'notes')],
    'conflict',
  );
  assert.deepEqual(await readdir(outside), []);
});

test('keep-local excludes the project skill folders and links', async (t) => {
  const paths = await tempPaths(t);
  const root = await tempDir(t);
  await run('git', ['init', '-q'], { cwd: root });
  const dir = await realpath(root);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  const project: ProjectContext = {
    dir,
    title: 'app',
    git: { root: dir, excludePath: join(dir, '.git', 'info', 'exclude') },
  };

  await installProject({
    paths,
    project,
    tools: ['claude-code'],
    skills: [skill],
    overrides: { keepLocal: true },
  });

  const exclude = await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\/\.agents\/skills\/notes$/m);
  assert.match(exclude, /^\/\.claude\/skills\/notes$/m);
});

test('a committed manifest that records a project folder as a skill is refused and deletes nothing', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  await writeFiles(dir, { 'src/lib/index.ts': 'export {};\n' });
  await writeFiles(dir, {
    '.agents/agents-config.json': JSON.stringify({
      version: MANIFEST_VERSION,
      scope: 'project',
      tools: ['claude-code'],
      blocks: [],
      skills: [],
      variables: {},
      options: {},
      entries: [
        {
          kind: 'skill',
          path: 'src/lib',
          name: 'lib',
          source: { type: 'local', path: 'skills/lib' },
          install: { mode: 'copy', hash: await hashTree(join(dir, 'src/lib')) },
        },
      ],
    }),
  });

  await assert.rejects(
    installProject({
      paths,
      project: { dir, title: 'app' },
      tools: ['claude-code'],
      skills: [],
    }),
    /the lib skill must be recorded at/,
  );

  assert.equal(
    await readFile(join(dir, 'src', 'lib', 'index.ts'), 'utf8'),
    'export {};\n',
  );
});

async function aliasClaudeSkills(paths: Paths): Promise<void> {
  await mkdir(paths.claudeHome, { recursive: true });
  await symlink(paths.skillsDir, join(paths.claudeHome, 'skills'));
}

test('a tool skills folder that links to the shared folder gets no per-skill link', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await mkdir(paths.skillsDir, { recursive: true });
  await aliasClaudeSkills(paths);

  const { plan } = await installGlobal(paths, {
    tools: ['claude-code'],
    skills: [skill],
  });

  const link = plan.actions.find(
    (action) => action.path === join(paths.claudeHome, 'skills', 'notes'),
  );
  assert.deepEqual(
    { status: link?.status, reason: link?.reason },
    { status: 'unchanged', reason: 'tool reads the shared skills folder' },
  );
  assert.ok((await lstat(join(paths.skillsDir, 'notes'))).isDirectory());
  assert.ok(
    (
      await stat(join(paths.claudeHome, 'skills', 'notes', 'SKILL.md'))
    ).isFile(),
  );
  assert.deepEqual(
    (await manifestOf(paths))?.entries.filter(
      (entry) => entry.kind === 'symlink',
    ),
    [],
  );
});

test('adopting through a tool skills folder that links to the shared folder keeps one copy', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await writeFiles(paths.skillsDir, { 'notes/SKILL.md': 'mine\n' });
  await aliasClaudeSkills(paths);
  const backupDir = join(paths.stateDir, 'backups', '2026-01-01T00-00-00Z');

  await installGlobal(paths, {
    tools: ['claude-code'],
    skills: [skill],
    adopt: { names: new Set(['notes']), backupDir },
  });

  assert.ok((await lstat(join(paths.skillsDir, 'notes'))).isDirectory());
  assert.equal(
    await readFile(join(paths.skillsDir, 'notes', 'SKILL.md'), 'utf8'),
    skillSource('notes'),
  );
  assert.equal(
    await readFile(join(backupDir, '.agents/skills/notes/SKILL.md'), 'utf8'),
    'mine\n',
  );
});

test('a recorded link under a folder that now links to the shared folder is dropped without touching the copy', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, { tools: ['claude-code'], skills: [skill] });
  await rm(join(paths.claudeHome, 'skills'), { recursive: true });
  await aliasClaudeSkills(paths);

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
  });

  assert.equal(
    plan.actions.find(
      (action) => action.path === join(paths.claudeHome, 'skills', 'notes'),
    )?.reason,
    'tool reads the shared skills folder',
  );
  assert.ok((await stat(join(paths.skillsDir, 'notes', 'SKILL.md'))).isFile());
  assert.deepEqual(
    (await manifestOf(paths))?.entries.filter(
      (entry) => entry.kind === 'symlink',
    ),
    [],
  );
});

test('a project skills folder that links to .agents/skills gets no per-skill link', async (t) => {
  const paths = await tempPaths(t);
  const dir = await realpath(await tempDir(t));
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await mkdir(join(dir, '.claude'));
  await symlink(
    join('..', '.agents', 'skills'),
    join(dir, '.claude', 'skills'),
  );

  const plan = await installProject({
    paths,
    project: { dir, title: 'app' },
    tools: ['claude-code'],
    skills: [skill],
  });

  assert.equal(
    statuses(plan)[join(dir, '.claude', 'skills', 'notes')],
    'unchanged',
  );
  assert.ok(
    (await lstat(join(dir, '.agents', 'skills', 'notes'))).isDirectory(),
  );
  assert.doesNotMatch(
    await readFile(projectManifestPath(dir), 'utf8'),
    /"kind": "symlink"/,
  );
});

for (const added of ['evals/mine.json', 'references/AGENTS.md', '.git/HEAD']) {
  test(`a copy with an added ${added} is neither replaced nor deleted`, async (t) => {
    const paths = await tempPaths(t);
    const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
    await installGlobal(paths, { tools: ['codex'], skills: [skill] });
    await writeFiles(join(paths.skillsDir, 'notes'), { [added]: 'mine\n' });
    await writeFiles(skill.dir, { 'references/new.md': 'new\n' });
    const canonical = join(paths.skillsDir, 'notes');

    const { plan: update } = await installGlobal(paths, {
      tools: ['codex'],
      skills: [skill],
    });
    const { plan: removal } = await installGlobal(paths, {
      tools: ['codex'],
      skills: [skill],
      selected: [],
    });

    assert.equal(
      update.actions.find((action) => action.path === canonical)?.reason,
      'changed outside agents-config, left in place',
    );
    assert.equal(
      removal.actions.find((action) => action.path === canonical)?.reason,
      'changed outside agents-config, left in place',
    );
    assert.equal(await readFile(join(canonical, added), 'utf8'), 'mine\n');
  });
}

test('running the scripts of a copy does not make it look edited', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({
    root: await tempDir(t),
    name: 'notes',
    files: { 'scripts/run.py': 'print()\n' },
  });
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  const canonical = join(paths.skillsDir, 'notes');
  await writeFiles(canonical, {
    'scripts/__pycache__/run.cpython-312.pyc': 'compiled\n',
    '.DS_Store': 'x',
  });
  await writeFiles(skill.dir, { 'references/new.md': 'new\n' });

  const { plan: update } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
  });
  const { plan: removal } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    selected: [],
  });

  assert.equal(statuses(update)[canonical], 'update');
  assert.equal(statuses(removal)[canonical], 'remove');
  await assert.rejects(lstat(canonical), { code: 'ENOENT' });
});

test('what a setup command creates does not make the copy look edited', async (t) => {
  const paths = await tempPaths(t);
  const skill: SkillSource = {
    ...(await localSkill({ root: await tempDir(t), name: 'notes' })),
    setup: 'mkdir -p node_modules/dep .venv && echo x > node_modules/dep/x.js',
  };
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  const canonical = join(paths.skillsDir, 'notes');
  const installed = (await manifestOf(paths))?.entries.find(
    (entry) => entry.kind === 'skill',
  );
  assert.ok((await stat(join(canonical, 'node_modules/dep/x.js'))).isFile());

  const { plan: again } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
  });
  const { plan: removal } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    selected: [],
  });

  assert.ok(installed?.kind === 'skill' && installed.install.mode === 'copy');
  assert.equal(installed.install.setup, true);
  assert.equal(statuses(again)[canonical], 'unchanged');
  assert.equal(statuses(removal)[canonical], 'remove');
  await assert.rejects(lstat(canonical), { code: 'ENOENT' });
});

test('dependencies added to a copy without a setup command make it look edited', async (t) => {
  const paths = await tempPaths(t);
  const skill = await localSkill({ root: await tempDir(t), name: 'notes' });
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  const canonical = join(paths.skillsDir, 'notes');
  await writeFiles(canonical, { 'node_modules/dep/x.js': 'mine\n' });

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    selected: [],
  });

  assert.equal(
    plan.actions.find((action) => action.path === canonical)?.reason,
    'changed outside agents-config, left in place',
  );
});

test('dropping a setup command replaces the copy and what setup created', async (t) => {
  const paths = await tempPaths(t);
  const plain = await localSkill({ root: await tempDir(t), name: 'notes' });
  const withSetup: SkillSource = {
    ...plain,
    setup: 'mkdir -p node_modules/dep && echo x > node_modules/dep/x.js',
  };
  await installGlobal(paths, { tools: ['codex'], skills: [withSetup] });
  const canonical = join(paths.skillsDir, 'notes');

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [plain],
  });
  const { plan: again } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [plain],
  });

  assert.equal(statuses(plan)[canonical], 'update');
  await assert.rejects(lstat(join(canonical, 'node_modules')), {
    code: 'ENOENT',
  });
  assert.equal(statuses(again)[canonical], 'unchanged');
});

test('a copy recorded before the setup flag keeps what setup created', async (t) => {
  const paths = await tempPaths(t);
  const skill: SkillSource = {
    ...(await localSkill({ root: await tempDir(t), name: 'notes' })),
    setup: 'mkdir -p node_modules/dep && echo x > node_modules/dep/x.js',
  };
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  const manifestPath = globalManifestPath(paths);
  const stored = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  for (const entry of stored.entries) {
    if (entry.kind === 'skill' && entry.install.mode === 'copy') {
      delete entry.install.setup;
    }
  }
  await writeFiles(dirname(manifestPath), {
    [basename(manifestPath)]: JSON.stringify(stored),
  });
  const canonical = join(paths.skillsDir, 'notes');

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
  });

  const recorded = (await manifestOf(paths))?.entries.find(
    (entry) => entry.kind === 'skill',
  );
  assert.equal(statuses(plan)[canonical], 'update');
  assert.ok(recorded?.kind === 'skill' && recorded.install.mode === 'copy');
  assert.equal(recorded.install.setup, true);
  assert.ok((await stat(join(canonical, 'node_modules/dep/x.js'))).isFile());
});

test('a setup copy recorded before the setup flag is removed when deselected', async (t) => {
  const paths = await tempPaths(t);
  const skill: SkillSource = {
    ...(await localSkill({ root: await tempDir(t), name: 'notes' })),
    setup: 'mkdir -p node_modules/dep && echo x > node_modules/dep/x.js',
  };
  await installGlobal(paths, { tools: ['codex'], skills: [skill] });
  const manifestPath = globalManifestPath(paths);
  const stored = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  for (const entry of stored.entries) {
    if (entry.kind === 'skill' && entry.install.mode === 'copy') {
      delete entry.install.setup;
    }
  }
  await writeFiles(dirname(manifestPath), {
    [basename(manifestPath)]: JSON.stringify(stored),
  });
  const canonical = join(paths.skillsDir, 'notes');

  const { plan } = await installGlobal(paths, {
    tools: ['codex'],
    skills: [skill],
    selected: [],
  });

  assert.equal(statuses(plan)[canonical], 'remove');
  await assert.rejects(lstat(canonical), { code: 'ENOENT' });
});
