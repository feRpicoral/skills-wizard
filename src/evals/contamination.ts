import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Paths } from '../env.ts';
import { lstatIfExists, walkDirectories } from '../install/fs.ts';
import { scanInstalledSkills, skillRoots } from '../skills/collisions.ts';
import { TOOLS } from '../tools/registry.ts';
import type { EvalRunnerName } from './workspace.ts';

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

export interface GlobalSkillCheckParams {
  skillName: string;
  paths?: Paths;
}

export async function isSkillInstalledGlobally({
  skillName,
  paths,
}: GlobalSkillCheckParams): Promise<boolean> {
  if (!paths) return false;
  for (const root of await skillRoots(paths)) {
    if ((await lstatIfExists(join(root.dir, skillName))) !== null) {
      return true;
    }
  }
  const scan = await scanInstalledSkills(paths, null);
  return scan.skills.some((skill) => skill.name === skillName);
}

const PLUGIN_SCAN_MAX_DEPTH = 8;
const PLUGIN_SCAN_SKIPPED = new Set(['.git', 'node_modules']);

export interface ClaudePluginSkillParams {
  skillName: string;
  paths?: Paths;
}

/**
 * Finds a `skills/<name>` folder anywhere under `~/.claude/plugins`, following
 * directory symlinks while guarding against symlink loops. Claude Code
 * namespaces plugin skills as `<plugin>:<name>`, and `skillOverrides` does not
 * apply to them.
 */
export async function findClaudePluginSkill({
  skillName,
  paths,
}: ClaudePluginSkillParams): Promise<string | undefined> {
  if (!paths) return undefined;
  for await (const entry of walkDirectories({
    root: join(paths.claudeHome, 'plugins'),
    maxDepth: PLUGIN_SCAN_MAX_DEPTH,
    skipNames: PLUGIN_SCAN_SKIPPED,
    followSymlinks: true,
  })) {
    if (entry.name === 'skills') {
      const candidate = join(entry.path, skillName);
      if ((await lstatIfExists(candidate)) !== null) return candidate;
    }
  }
  return undefined;
}

export interface ApplyBaselineExclusionParams {
  workdir: string;
  skillName?: string;
  skillNames?: readonly string[];
  runner: EvalRunnerName;
  paths?: Paths;
}

export async function applyBaselineExclusion({
  workdir,
  skillName,
  skillNames,
  runner,
  paths,
}: ApplyBaselineExclusionParams): Promise<{
  possiblyContaminated: boolean;
  warning?: string;
}> {
  const names = [
    ...new Set([
      ...(skillName !== undefined ? [skillName] : []),
      ...(skillNames ?? []),
    ]),
  ];
  if (runner === 'fake' || names.length === 0) {
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
          skillOverrides: Object.fromEntries(
            names.map((name) => [name, 'off']),
          ),
          permissions: {
            deny: names.flatMap((name) => [
              `Skill(${name})`,
              `Skill(${name} *)`,
              `Skill(skill:${name})`,
            ]),
          },
        },
        null,
        2,
      )}\n`,
    );
    const warnings: string[] = [];
    for (const name of names) {
      const pluginSkill = await findClaudePluginSkill({
        skillName: name,
        paths,
      });
      if (pluginSkill !== undefined) {
        warnings.push(
          `Claude Code plugin skill "${pluginSkill}" is not covered by skillOverrides or the Skill deny rules; baseline is possibly contaminated.`,
        );
      }
    }
    if (warnings.length > 0) {
      return {
        possiblyContaminated: true,
        warning: warnings.join(' '),
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
      `${JSON.stringify({ skills: { disabled: names } }, null, 2)}\n`,
    );
    return { possiblyContaminated: false };
  }

  // agy and codex document no workspace-level way to turn off one skill.
  const warnings: string[] = [];
  for (const name of names) {
    const installedGlobally = await isSkillInstalledGlobally({
      skillName: name,
      paths,
    });
    if (installedGlobally) {
      warnings.push(
        `Runner "${runner}" has no documented workspace-level skill exclusion and "${name}" is installed globally; baseline is possibly contaminated.`,
      );
    }
  }
  if (warnings.length > 0) {
    return {
      possiblyContaminated: true,
      warning: warnings.join(' '),
    };
  }
  return { possiblyContaminated: false };
}
