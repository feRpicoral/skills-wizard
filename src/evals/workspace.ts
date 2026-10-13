import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { type Environment, gitEnvironment, type Paths } from '../env.ts';
import { EvalError } from '../errors.ts';
import { lstatIfExists, readDirIfExists } from '../install/fs.ts';
import { scanInstalledSkills } from '../skills/collisions.ts';
import { failureDetail } from '../skills/process.ts';
import { copySkillTree, escapingLinks } from '../skills/tree.ts';
import { type ToolId, TOOLS } from '../tools/registry.ts';
import type { EvalCase } from './cases.ts';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

/**
 * Config passed to every git command run in an eval workspace, so that hooks
 * and fsmonitor commands from the user's global git config never run.
 */
const WORKSPACE_GIT_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
] as const;

/** Directories the harness or the agent CLIs own inside an eval workspace. */
const HARNESS_OWNED_DIRS = ['.agents', '.claude', '.gemini', '.codex'] as const;

const DEFAULT_PROJECT_SKILLS_DIR = posix.join('.agents', 'skills');

/** Fixture file name that is staged into eval workspaces as `SKILL.md`. */
export const FIXTURE_SKILL_FILE = 'SKILL.fixture.md';

export type CompareSkillVariant = `compare:${string}`;

export type EvalVariant =
  'with_skill' | 'without_skill' | 'old_skill' | CompareSkillVariant;

export interface ComparedSkillSpec {
  skillName: string;
  skillDir: string;
}

export function compareSkillVariant(skillName: string): CompareSkillVariant {
  return `compare:${skillName}`;
}

export function parseCompareSkillVariant(
  variant: EvalVariant,
): string | undefined {
  return variant.startsWith('compare:')
    ? variant.slice('compare:'.length)
    : undefined;
}

export function variantDirName(variant: EvalVariant): string {
  const compared = parseCompareSkillVariant(variant);
  return compared !== undefined ? `compare-${compared}` : variant;
}

export type EvalRunnerName = 'agy' | 'claude' | 'codex' | 'gemini' | 'fake';

const RUNNER_TOOLS: Readonly<Record<EvalRunnerName, ToolId | null>> = {
  agy: 'antigravity-cli',
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini-cli',
  fake: null,
};

/**
 * The project skills folder the runner's CLI reads, relative to the workspace
 * (`.claude/skills` for Claude Code, `.agents/skills` for every other runner).
 */
export function projectSkillsDir(runner: EvalRunnerName): string {
  const tool = RUNNER_TOOLS[runner];
  const folder = tool ? TOOLS[tool].project.skills : undefined;
  return folder ? folder.replaceAll('\\', '/') : DEFAULT_PROJECT_SKILLS_DIR;
}

export interface StagedSkillDirParams {
  workdir: string;
  runner: EvalRunnerName;
  skillName: string;
}

/** Where the skill under evaluation is staged in a workspace for a runner. */
export function stagedSkillDir({
  workdir,
  runner,
  skillName,
}: StagedSkillDirParams): string {
  return join(workdir, projectSkillsDir(runner), skillName);
}

export interface PersonalSkillShadowParams {
  runner: EvalRunnerName;
  skillName: string;
  paths?: Paths;
}

/**
 * Returns a warning when a personal skill with the same name would be loaded
 * instead of the staged project skill. Claude Code runs a personal skill in
 * `~/.claude/skills/<name>` over a project skill with the same name.
 */
export async function personalSkillShadowWarning({
  runner,
  skillName,
  paths,
}: PersonalSkillShadowParams): Promise<string | undefined> {
  if (!paths || runner !== 'claude') return undefined;
  const personalRoot = TOOLS['claude-code'].global.skills?.(paths);
  if (!personalRoot) return undefined;
  const personalDir = join(personalRoot, skillName);
  if ((await lstatIfExists(personalDir)) === null) return undefined;
  return `Claude Code loads the personal skill "${personalDir}" instead of the staged project skill "${skillName}"; results are possibly contaminated.`;
}

export interface PreparedWorkspace {
  workdir: string;
  variant: EvalVariant;
  runner: EvalRunnerName;
  skillName: string;
  /**
   * True only for a `without_skill` workspace whose baseline may still load
   * the skill. Use it for `metadata.baseline_status`.
   */
  possiblyContaminated: boolean;
  /**
   * True only for a `with_skill` or `old_skill` workspace where another copy
   * of the skill (a personal Claude skill) is loaded instead of the staged
   * one. Use it for `metadata.with_skill_contaminated`.
   */
  skillShadowed: boolean;
  warning?: string;
}

export interface MapCaseFileParams {
  fileEntry: string;
  caseId: string;
}

export function mapCaseFileRelativePath({
  fileEntry,
  caseId,
}: MapCaseFileParams): string {
  const normalized = posix.normalize(fileEntry.trim().replaceAll('\\', '/'));
  const prefix = 'evals/files/';
  const afterPrefix = normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
  const casePrefix = `${caseId}/`;
  const relative =
    afterPrefix.startsWith(casePrefix) && afterPrefix.length > casePrefix.length
      ? afterPrefix.slice(casePrefix.length)
      : afterPrefix;
  // Fixture skills are stored as SKILL.fixture.md so that tools scanning a
  // linked skill folder never discover them; they are staged as SKILL.md.
  if (posix.basename(relative) === FIXTURE_SKILL_FILE) {
    return posix.join(posix.dirname(relative), 'SKILL.md');
  }
  return relative;
}

export interface CaseFileDestinationsParams {
  evalCase: Pick<EvalCase, 'id' | 'files'>;
  skillName: string;
  compareSkillNames?: readonly string[];
}

function isUnderDir(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Checks where a case's fixture files land in the workspace before anything
 * is copied: destinations must stay inside the workspace, must not be inside
 * `.git/`, the staged skill folder or a directory the harness and agent CLIs
 * own (`.agents/`, `.claude/`, `.gemini/`, `.codex/`), and must not collide
 * with each other. Comparisons ignore case, as on case-insensitive file
 * systems. Throws an `EvalError` describing every problem.
 */
export function validateCaseFileDestinations({
  evalCase,
  skillName,
  compareSkillNames = [],
}: CaseFileDestinationsParams): void {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const allSkillNames = [skillName, ...compareSkillNames];
  const stagedDirs = new Set(
    (Object.keys(RUNNER_TOOLS) as EvalRunnerName[]).flatMap((runner) =>
      allSkillNames.map((name) =>
        posix.join(projectSkillsDir(runner), name).toLowerCase(),
      ),
    ),
  );

  for (const fileEntry of evalCase.files) {
    const dest = mapCaseFileRelativePath({ fileEntry, caseId: evalCase.id });
    const folded = dest.toLowerCase();
    if (
      dest === '' ||
      dest === '.' ||
      posix.isAbsolute(dest) ||
      dest === '..' ||
      dest.startsWith('../')
    ) {
      problems.push(`"${fileEntry}" maps outside the workspace ("${dest}")`);
      continue;
    }
    if (isUnderDir(folded, '.git')) {
      problems.push(`"${fileEntry}" maps into ".git/" ("${dest}")`);
      continue;
    }
    const stagedDir = [...stagedDirs].find((dir) => isUnderDir(folded, dir));
    if (stagedDir) {
      problems.push(
        `"${fileEntry}" maps into the staged skill folder "${stagedDir}/" ("${dest}")`,
      );
      continue;
    }
    const ownedDir = HARNESS_OWNED_DIRS.find((dir) => isUnderDir(folded, dir));
    if (ownedDir) {
      problems.push(
        `"${fileEntry}" maps into "${ownedDir}/", which the eval harness and agent CLIs own ("${dest}")`,
      );
      continue;
    }
    const previous = seen.get(folded);
    if (previous !== undefined) {
      problems.push(
        `"${fileEntry}" and "${previous}" map to the same destination "${dest}"`,
      );
      continue;
    }
    seen.set(folded, fileEntry);
  }

  for (const [folded, fileEntry] of seen) {
    for (const [other, otherEntry] of seen) {
      if (other !== folded && other.startsWith(`${folded}/`)) {
        problems.push(
          `"${fileEntry}" maps to a file that "${otherEntry}" needs as a directory`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new EvalError(
      `Eval case "${evalCase.id}" has invalid fixture files: ${problems.join('; ')}`,
    );
  }
}

export interface EvalSuiteFileDestinationsParams {
  cases: readonly Pick<EvalCase, 'id' | 'files'>[];
  skillName: string;
  compareSkillNames?: readonly string[];
}

/**
 * Runs `validateCaseFileDestinations` for every case, so an eval can fail
 * before any job starts.
 */
export function validateEvalSuiteFileDestinations({
  cases,
  skillName,
  compareSkillNames,
}: EvalSuiteFileDestinationsParams): void {
  for (const evalCase of cases) {
    validateCaseFileDestinations({ evalCase, skillName, compareSkillNames });
  }
}

interface GitCommandParams {
  cwd: string;
  args: string[];
  env?: Environment;
  failure: string;
}

async function runGit({
  cwd,
  args,
  env,
  failure,
}: GitCommandParams): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitEnvironment(env),
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    throw new EvalError(`${failure}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}

interface CopyCaseFilesParams {
  skillDir: string;
  skillName: string;
  workdir: string;
  evalCase: EvalCase;
}

async function copyCaseFiles({
  skillDir,
  skillName,
  workdir,
  evalCase,
}: CopyCaseFilesParams): Promise<void> {
  validateCaseFileDestinations({ evalCase, skillName });
  for (const fileEntry of evalCase.files) {
    const srcPath = join(skillDir, fileEntry);
    const relDest = mapCaseFileRelativePath({
      fileEntry,
      caseId: evalCase.id,
    });
    const destPath = join(workdir, relDest);
    const info = await stat(srcPath);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    await chmod(destPath, info.mode & 0o777);
  }
}

interface InitWorkspaceGitParams {
  workdir: string;
  env?: Environment;
}

async function initWorkspaceGit({
  workdir,
  env,
}: InitWorkspaceGitParams): Promise<void> {
  await runGit({
    cwd: workdir,
    args: [...WORKSPACE_GIT_CONFIG, 'init'],
    env,
    failure: 'Failed to initialize eval workspace git repository',
  });
  const excludePath = join(workdir, '.git', 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(
    excludePath,
    [...HARNESS_OWNED_DIRS.map((dir) => `${dir}/`), ''].join('\n'),
  );
  await runGit({
    cwd: workdir,
    args: [...WORKSPACE_GIT_CONFIG, 'add', '-A'],
    env,
    failure: 'Failed to stage eval workspace fixture files',
  });
  await runGit({
    cwd: workdir,
    args: [
      ...WORKSPACE_GIT_CONFIG,
      '-c',
      'user.name=agents-config',
      '-c',
      'user.email=eval@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '--allow-empty',
      '-m',
      'chore: eval workspace fixture',
    ],
    env,
    failure: 'Failed to commit eval workspace fixture files',
  });
}

export interface ExtractSkillAtRefParams {
  repoRoot: string;
  skillDir: string;
  ref: string;
  destDir: string;
  env?: Environment;
}

export async function extractSkillAtRef({
  repoRoot,
  skillDir,
  ref,
  destDir,
  env,
}: ExtractSkillAtRefParams): Promise<void> {
  assertSafeGitRef(ref);
  const relSkillDir = await skillPathInRepository({ repoRoot, skillDir });
  const prefix = `${relSkillDir}/`;
  const treeOutput = await gitOutput({
    cwd: repoRoot,
    args: [
      '--literal-pathspecs',
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      ref,
      '--',
      prefix,
    ],
    env,
    failure: `Failed to read skill "${relSkillDir}" at ref "${ref}"`,
  });
  const entries = parseTreeEntries({ output: treeOutput, prefix });
  if (entries.length === 0) {
    throw new EvalError(`Skill "${relSkillDir}" was not found at ref "${ref}"`);
  }

  await mkdir(destDir, { recursive: true });
  // Regular files first, links last, so no write ever goes through a link.
  const links: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.mode === SYMLINK_MODE) {
      links.push(entry);
      continue;
    }
    const outPath = join(destDir, ...entry.relPath.split('/'));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, await readBlob({ repoRoot, entry, ref, env }));
    if (entry.mode === EXECUTABLE_MODE) {
      await chmod(outPath, 0o755);
    }
  }
  for (const entry of links) {
    const target = (await readBlob({ repoRoot, entry, ref, env })).toString(
      'utf8',
    );
    if (!target || isAbsolute(target) || target.includes('\0')) {
      throw new EvalError(
        `Skill "${relSkillDir}" at ref "${ref}" has a link "${entry.relPath}" that points outside the skill (${target})`,
      );
    }
    const outPath = join(destDir, ...entry.relPath.split('/'));
    await mkdir(dirname(outPath), { recursive: true });
    await symlink(target, outPath);
  }
  const escaping = await escapingLinks(destDir);
  if (escaping.length > 0) {
    const detail = escaping
      .map((link) => `${link.path} -> ${link.target}`)
      .join(', ');
    throw new EvalError(
      `Skill "${relSkillDir}" at ref "${ref}" has links that point outside the skill: ${detail}`,
    );
  }
}

interface ApplyBaselineExclusionParams {
  workdir: string;
  skillName: string;
  runner: EvalRunnerName;
  paths?: Paths;
}

interface GlobalSkillCheckParams {
  skillName: string;
  paths?: Paths;
}

async function isSkillInstalledGlobally({
  skillName,
  paths,
}: GlobalSkillCheckParams): Promise<boolean> {
  if (!paths) return false;
  const candidateDirs = [
    join(paths.skillsDir, skillName),
    join(paths.claudeHome, 'skills', skillName),
    join(paths.codexHome, 'skills', skillName),
    join(paths.geminiHome, 'skills', skillName),
    join(paths.geminiHome, 'config', 'skills', skillName),
    join(paths.geminiHome, 'antigravity-cli', 'skills', skillName),
    join(paths.copilotHome, 'skills', skillName),
  ];
  for (const dir of candidateDirs) {
    if ((await lstatIfExists(dir)) !== null) {
      return true;
    }
  }
  const agyPluginsDir = join(paths.geminiHome, 'antigravity-cli', 'plugins');
  for (const plugin of (await readDirIfExists(agyPluginsDir)) ?? []) {
    const dir = join(agyPluginsDir, plugin.name, 'skills', skillName);
    if ((await lstatIfExists(dir)) !== null) {
      return true;
    }
  }
  const scan = await scanInstalledSkills(paths, null);
  return scan.skills.some((skill) => skill.name === skillName);
}

const PLUGIN_SCAN_MAX_DEPTH = 8;
const PLUGIN_SCAN_SKIPPED = new Set(['.git', 'node_modules']);

interface ClaudePluginSkillParams {
  skillName: string;
  paths?: Paths;
}

/**
 * Finds a `skills/<name>` folder anywhere under `~/.claude/plugins`, without
 * following links. Claude Code namespaces plugin skills as
 * `<plugin>:<name>`, and `skillOverrides` does not apply to them.
 */
export async function findClaudePluginSkill({
  skillName,
  paths,
}: ClaudePluginSkillParams): Promise<string | undefined> {
  if (!paths) return undefined;
  const pending: { dir: string; depth: number }[] = [
    { dir: join(paths.claudeHome, 'plugins'), depth: 0 },
  ];
  while (pending.length > 0) {
    const next = pending.shift();
    if (!next) break;
    let entries;
    try {
      entries = await readDirIfExists(next.dir);
    } catch {
      continue;
    }
    for (const entry of entries ?? []) {
      if (!entry.isDirectory() || PLUGIN_SCAN_SKIPPED.has(entry.name)) {
        continue;
      }
      const dir = join(next.dir, entry.name);
      if (entry.name === 'skills') {
        const candidate = join(dir, skillName);
        if ((await lstatIfExists(candidate)) !== null) return candidate;
      }
      if (next.depth < PLUGIN_SCAN_MAX_DEPTH) {
        pending.push({ dir, depth: next.depth + 1 });
      }
    }
  }
  return undefined;
}

export async function applyBaselineExclusion({
  workdir,
  skillName,
  runner,
  paths,
}: ApplyBaselineExclusionParams): Promise<{
  possiblyContaminated: boolean;
  warning?: string;
}> {
  if (runner === 'fake') {
    return { possiblyContaminated: false };
  }

  if (runner === 'claude') {
    // Documented in the Claude Code skills and permissions docs: a
    // `skillOverrides` entry of "off" hides a personal or project skill, deny
    // rules block in every permission mode, including bypassPermissions, and
    // the parameter form `Skill(skill:<name>)` matches the skill under any of
    // its names, such as an alias or display name. Neither is documented to
    // cover a plugin skill, so one is reported as possible contamination.
    const file = join(workdir, '.claude', 'settings.local.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        {
          skillOverrides: { [skillName]: 'off' },
          permissions: {
            deny: [
              `Skill(${skillName})`,
              `Skill(${skillName} *)`,
              `Skill(skill:${skillName})`,
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const pluginSkill = await findClaudePluginSkill({ skillName, paths });
    if (pluginSkill !== undefined) {
      return {
        possiblyContaminated: true,
        warning: `Claude Code plugin skill "${pluginSkill}" is not covered by skillOverrides or the Skill deny rules; baseline is possibly contaminated.`,
      };
    }
    return { possiblyContaminated: false };
  }

  if (runner === 'gemini') {
    // Documented in the Gemini CLI configuration reference (`skills.disabled`).
    // Workspace settings load only in a trusted folder; a headless run in an
    // untrusted folder exits with FatalUntrustedWorkspaceError instead.
    const file = join(workdir, '.gemini', 'settings.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ skills: { disabled: [skillName] } }, null, 2)}\n`,
    );
    return { possiblyContaminated: false };
  }

  // agy and codex document no workspace-level way to turn off one skill.
  const installedGlobally = await isSkillInstalledGlobally({
    skillName,
    paths,
  });
  if (installedGlobally) {
    return {
      possiblyContaminated: true,
      warning: `Runner "${runner}" has no documented workspace-level skill exclusion and "${skillName}" is installed globally; baseline is possibly contaminated.`,
    };
  }
  return { possiblyContaminated: false };
}

export interface PrepareEvalWorkspaceParams {
  runDir: string;
  skillDir: string;
  skillName: string;
  evalCase: EvalCase;
  variant: EvalVariant;
  runner: EvalRunnerName;
  paths?: Paths;
  repoRoot?: string;
  compareRef?: string;
  compareSkill?: ComparedSkillSpec;
  env?: Environment;
}

export async function prepareEvalWorkspace({
  runDir,
  skillDir,
  skillName,
  evalCase,
  variant,
  runner,
  paths,
  repoRoot,
  compareRef,
  compareSkill,
  env,
}: PrepareEvalWorkspaceParams): Promise<PreparedWorkspace> {
  const workdir = join(runDir, 'workdir');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });

  await copyCaseFiles({ skillDir, skillName, workdir, evalCase });
  await initWorkspaceGit({ workdir, env });

  if (variant === 'with_skill' || variant === 'old_skill') {
    const destSkillDir = stagedSkillDir({ workdir, runner, skillName });
    if (variant === 'with_skill') {
      await copySkillTree({ source: skillDir, destination: destSkillDir });
    } else {
      if (!repoRoot || !compareRef) {
        throw new EvalError(
          'old_skill workspace requires both repoRoot and compareRef',
        );
      }
      const snapshotDir = join(runDir, '.old-skill-snapshot');
      await rm(snapshotDir, { recursive: true, force: true });
      try {
        await extractSkillAtRef({
          repoRoot,
          skillDir,
          ref: compareRef,
          destDir: snapshotDir,
          env,
        });
        await copySkillTree({ source: snapshotDir, destination: destSkillDir });
      } finally {
        await rm(snapshotDir, { recursive: true, force: true });
      }
    }
    const warning = await personalSkillShadowWarning({
      runner,
      skillName,
      paths,
    });
    return {
      workdir,
      variant,
      runner,
      skillName,
      possiblyContaminated: false,
      skillShadowed: warning !== undefined,
      ...(warning ? { warning } : {}),
    };
  }

  if (parseCompareSkillVariant(variant) !== undefined) {
    if (!compareSkill) {
      throw new EvalError(`${variant} workspace requires compareSkill`);
    }
    const destSkillDir = stagedSkillDir({
      workdir,
      runner,
      skillName: compareSkill.skillName,
    });
    await copySkillTree({
      source: compareSkill.skillDir,
      destination: destSkillDir,
    });
    await applyBaselineExclusion({
      workdir,
      skillName,
      runner,
      paths,
    });
    const warning = await personalSkillShadowWarning({
      runner,
      skillName: compareSkill.skillName,
      paths,
    });
    return {
      workdir,
      variant,
      runner,
      skillName: compareSkill.skillName,
      possiblyContaminated: false,
      skillShadowed: warning !== undefined,
      ...(warning ? { warning } : {}),
    };
  }

  const exclusion = await applyBaselineExclusion({
    workdir,
    skillName,
    runner,
    paths,
  });
  return {
    workdir,
    variant,
    runner,
    skillName,
    possiblyContaminated: exclusion.possiblyContaminated,
    skillShadowed: false,
    ...(exclusion.warning ? { warning: exclusion.warning } : {}),
  };
}

export interface PrepareTriggerWorkspaceParams {
  runDir: string;
  skillDir: string;
  skillName: string;
  runner: EvalRunnerName;
  env?: Environment;
}

/**
 * Prepares a trigger-eval workspace with the skill staged where the runner
 * reads project skills. Call `personalSkillShadowWarning` once per trigger
 * eval to report a personal skill that would be loaded instead.
 */
export async function prepareTriggerWorkspace({
  runDir,
  skillDir,
  skillName,
  runner,
  env,
}: PrepareTriggerWorkspaceParams): Promise<string> {
  const workdir = join(runDir, 'workdir');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  await initWorkspaceGit({ workdir, env });
  const destSkillDir = stagedSkillDir({ workdir, runner, skillName });
  await copySkillTree({ source: skillDir, destination: destSkillDir });
  return workdir;
}

const SYMLINK_MODE = '120000';
const EXECUTABLE_MODE = '100755';
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Rejects refs git would read as an option, and other malformed refs. */
export function assertSafeGitRef(ref: string): void {
  if (
    ref.trim() === '' ||
    ref.startsWith('-') ||
    ref.includes('\0') ||
    /[\r\n]/.test(ref)
  ) {
    throw new EvalError(
      `Invalid git ref "${ref}": refs must be non-empty and cannot start with "-"`,
    );
  }
}

interface GitOutputParams {
  cwd: string;
  args: string[];
  env?: Environment;
  failure: string;
}

async function gitOutput({
  cwd,
  args,
  env,
  failure,
}: GitOutputParams): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: gitEnvironment(env),
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    throw new EvalError(`${failure}: ${failureDetail(error)}`, {
      cause: error,
    });
  }
}

interface SkillPathParams {
  repoRoot: string;
  skillDir: string;
}

// Both sides are resolved so a skill reached through a symlinked folder (or
// macOS /var -> /private/var) still maps onto the repository tree.
async function skillPathInRepository({
  repoRoot,
  skillDir,
}: SkillPathParams): Promise<string> {
  let realRoot: string;
  let realSkill: string;
  try {
    realRoot = await realpath(repoRoot);
    realSkill = await realpath(skillDir);
  } catch (error) {
    throw new EvalError(
      `Cannot resolve skill directory "${skillDir}" in repository "${repoRoot}"`,
      { cause: error },
    );
  }
  const relSkillDir = relative(realRoot, realSkill)
    .split(sep)
    .join('/')
    .replace(/\/+$/, '');
  if (
    !relSkillDir ||
    relSkillDir === '..' ||
    relSkillDir.startsWith('../') ||
    isAbsolute(relSkillDir)
  ) {
    throw new EvalError(
      `Skill directory "${skillDir}" is not inside a subfolder of repository "${repoRoot}"`,
    );
  }
  return relSkillDir;
}

interface TreeEntry {
  mode: string;
  objectHash: string;
  relPath: string;
}

interface ParseTreeEntriesParams {
  output: string;
  prefix: string;
}

function isSafeTreePath(relPath: string): boolean {
  return (
    relPath !== '' &&
    !isAbsolute(relPath) &&
    relPath
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

// `ls-tree -z` output: `<mode> SP <type> SP <object> TAB <path>` records
// separated by NUL, with paths left unquoted.
function parseTreeEntries({
  output,
  prefix,
}: ParseTreeEntriesParams): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) continue;
    const [mode, type, objectHash] = record.slice(0, tabIndex).split(' ');
    const treePath = record.slice(tabIndex + 1);
    // Submodules (type "commit") have no content to extract.
    if (type !== 'blob' || !mode || !objectHash) continue;
    if (!treePath.startsWith(prefix)) continue;
    const relPath = treePath.slice(prefix.length);
    if (!isSafeTreePath(relPath)) {
      throw new EvalError(`Refusing to extract unsafe path "${treePath}"`);
    }
    entries.push({ mode, objectHash, relPath });
  }
  return entries;
}

interface ReadBlobParams {
  repoRoot: string;
  entry: TreeEntry;
  ref: string;
  env?: Environment;
}

async function readBlob({
  repoRoot,
  entry,
  ref,
  env,
}: ReadBlobParams): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['cat-file', 'blob', entry.objectHash],
      {
        cwd: repoRoot,
        env: gitEnvironment(env),
        encoding: 'buffer',
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    return stdout;
  } catch (error) {
    throw new EvalError(
      `Failed to read "${entry.relPath}" at ref "${ref}": ${failureDetail(error)}`,
      { cause: error },
    );
  }
}

export interface ResolveSkillRepositoryParams {
  skillDir: string;
  env?: Environment;
}

/** The root of the git repository that contains the skill directory. */
export async function resolveSkillRepository({
  skillDir,
  env,
}: ResolveSkillRepositoryParams): Promise<string> {
  const output = await gitOutput({
    cwd: skillDir,
    args: ['rev-parse', '--show-toplevel'],
    env,
    failure: `Skill directory "${skillDir}" is not inside a git repository`,
  });
  const repoRoot = output.trim();
  if (!repoRoot) {
    throw new EvalError(
      `Skill directory "${skillDir}" is not inside a git work tree`,
    );
  }
  return repoRoot;
}

export interface VerifySkillAtRefParams {
  repoRoot: string;
  skillDir: string;
  ref: string;
  env?: Environment;
}

/** Fails early when the ref is not a commit or the skill is absent at it. */
export async function verifySkillAtRef({
  repoRoot,
  skillDir,
  ref,
  env,
}: VerifySkillAtRefParams): Promise<void> {
  assertSafeGitRef(ref);
  const relSkillDir = await skillPathInRepository({ repoRoot, skillDir });
  await gitOutput({
    cwd: repoRoot,
    args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
    env,
    failure: `Git ref "${ref}" does not name a commit in ${repoRoot}`,
  });
  const type = await gitOutput({
    cwd: repoRoot,
    args: ['cat-file', '-t', `${ref}:${relSkillDir}`],
    env,
    failure: `Skill "${relSkillDir}" does not exist at ref "${ref}"`,
  });
  if (type.trim() !== 'tree') {
    throw new EvalError(
      `Skill "${relSkillDir}" at ref "${ref}" is not a directory`,
    );
  }
}
