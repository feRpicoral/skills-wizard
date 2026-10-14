import { chmod, copyFile, mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';

import { EvalError } from '../errors.ts';
import { statIfExists } from '../install/fs.ts';
import { runSetup } from '../skills/setup.ts';
import { escapingLinks } from '../skills/tree.ts';
import { copySkillTree } from '../skills/tree-replace.ts';
import { isSkillName } from '../skills/validate.ts';
import { type ToolId, TOOLS } from '../tools/registry.ts';
import type { EvalCase } from './cases.ts';

/** Directories the harness or the agent CLIs own inside an eval workspace. */
export const HARNESS_OWNED_DIRS = [
  '.agents',
  '.claude',
  '.gemini',
  '.codex',
] as const;

const DEFAULT_PROJECT_SKILLS_DIR = posix.join('.agents', 'skills');

/** Fixture file name that is staged into eval workspaces as `SKILL.md`. */
export const FIXTURE_SKILL_FILE = 'SKILL.fixture.md';

export const EVAL_RUNNER_NAMES = [
  'agy',
  'claude',
  'codex',
  'gemini',
  'fake',
] as const;

export type EvalRunnerName = (typeof EVAL_RUNNER_NAMES)[number];

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
    EVAL_RUNNER_NAMES.flatMap((runner) =>
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

export interface CopyCaseFilesParams {
  skillDir: string;
  skillName: string;
  compareSkillNames?: readonly string[];
  workdir: string;
  evalCase: EvalCase;
}

export async function copyCaseFiles({
  skillDir,
  skillName,
  compareSkillNames,
  workdir,
  evalCase,
}: CopyCaseFilesParams): Promise<void> {
  validateCaseFileDestinations({ evalCase, skillName, compareSkillNames });
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

export interface ComparedSkillSpec {
  skillName: string;
  skillDir: string;
  setup?: string;
}

export async function validateComparedSkillSpecs(
  skillName: string,
  compareSkills: readonly ComparedSkillSpec[] | undefined,
): Promise<Map<string, ComparedSkillSpec>> {
  const compareSkillsByName = new Map<string, ComparedSkillSpec>();

  for (const item of compareSkills ?? []) {
    if (!isSkillName(item.skillName)) {
      throw new EvalError(
        `Compared skill name "${item.skillName}" is not a valid skill name`,
      );
    }

    if (item.skillName === skillName) {
      throw new EvalError(
        `Compared skill "${item.skillName}" must have a different name from the target skill "${skillName}"`,
      );
    }

    if (compareSkillsByName.has(item.skillName)) {
      throw new EvalError(
        `Duplicate compared skill name "${item.skillName}" in compareSkills`,
      );
    }

    const skillMd = await statIfExists(join(item.skillDir, 'SKILL.md'));

    if (!skillMd?.isFile()) {
      throw new EvalError(
        `Compared skill "${item.skillName}" is missing SKILL.md in ${item.skillDir}`,
      );
    }

    const itemEscaping = await escapingLinks(item.skillDir);

    if (itemEscaping.length > 0) {
      throw new EvalError(
        `Compared skill "${item.skillName}" has links that point outside the skill folder: ${itemEscaping.map((link) => `${link.path} -> ${link.target}`).join(', ')}`,
      );
    }

    compareSkillsByName.set(item.skillName, item);
  }

  return compareSkillsByName;
}

export async function prepareComparedSkillSetups(
  compareSkillsByName: Map<string, ComparedSkillSpec>,
  tempDirs: string[],
): Promise<void> {
  for (const [name, item] of compareSkillsByName) {
    if (!item.setup) continue;

    const tempRoot = await mkdtemp(join(tmpdir(), 'skills-wizard-compare-'));

    tempDirs.push(tempRoot);
    const preparedDir = join(tempRoot, item.skillName);

    await copySkillTree({ source: item.skillDir, destination: preparedDir });
    await runSetup({ dir: preparedDir, command: item.setup });
    compareSkillsByName.set(name, {
      skillName: item.skillName,
      skillDir: preparedDir,
    });
  }
}
