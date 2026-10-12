import * as clack from '@clack/prompts';

import type { BlockLibrary, Scope } from '../blocks/library.ts';
import { variableMessage } from '../blocks/variables.ts';
import type { Paths } from '../env.ts';
import { CancelledError } from '../errors.ts';
import { displayPath } from '../install/describe.ts';
import type { SkillMode } from '../skills/install.ts';
import type { SkillDefinition, SkillLibrary } from '../skills/library.ts';
import { TOOL_IDS, type ToolId, TOOLS } from '../tools/registry.ts';

export function unwrap<T>(value: T | symbol): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new CancelledError('Cancelled');
  return value as Exclude<T, symbol>;
}

export async function promptScope(): Promise<Scope> {
  return unwrap(
    await clack.select<Scope>({
      message: 'What do you want to set up?',
      options: [
        { value: 'global', label: 'System-wide', hint: 'every project' },
        { value: 'project', label: 'A project', hint: 'one directory' },
      ],
    }),
  );
}

export async function promptProjectDir(cwd: string): Promise<string> {
  return unwrap(
    await clack.path({
      message: 'Project directory',
      root: cwd,
      directory: true,
      initialValue: cwd,
    }),
  );
}

export async function promptTools(
  scope: Scope,
  initial: readonly ToolId[],
  paths: Paths,
): Promise<ToolId[]> {
  return unwrap(
    await clack.multiselect<ToolId>({
      message: 'Which tools should get these instructions?',
      options: TOOL_IDS.map((id) => ({
        value: id,
        label: TOOLS[id].label,
        hint:
          scope === 'global'
            ? displayPath({
                path: TOOLS[id].global.instructions(paths),
                home: paths.home,
              })
            : undefined,
      })),
      initialValues: [...initial],
      required: false,
    }),
  );
}

export async function promptBlocks(
  library: BlockLibrary,
  scope: Scope,
  initial: readonly string[],
): Promise<string[]> {
  const groups: Record<
    string,
    { value: string; label: string; hint: string }[]
  > = {};
  const available = library.blocks.filter((block) =>
    block.scopes.includes(scope),
  );
  for (const block of available) {
    const group = library.groups[block.group] ?? block.group;
    (groups[group] ??= []).push({
      value: block.id,
      label: block.title,
      hint: block.summary,
    });
  }

  return unwrap(
    await clack.groupMultiselect<string>({
      message: 'Which blocks should the instructions include?',
      options: groups,
      initialValues: initial.filter((id) =>
        available.some((block) => block.id === id),
      ),
      required: false,
    }),
  );
}

function skillHint(skill: SkillDefinition): string {
  if (skill.origin.type === 'local') return skill.origin.path;
  const { repo, note } = skill.origin.entry;
  return note ? `${repo}: ${note}` : repo;
}

export async function promptSkills(
  library: SkillLibrary,
  scope: Scope,
  initial: readonly string[],
): Promise<string[]> {
  const available = library.skills.filter((skill) =>
    skill.scopes.includes(scope),
  );
  if (available.length === 0) return [];
  const groups: Record<
    string,
    { value: string; label: string; hint: string }[]
  > = {};
  for (const skill of available) {
    (groups[skill.group] ??= []).push({
      value: skill.name,
      label: skill.name,
      hint: skillHint(skill),
    });
  }

  return unwrap(
    await clack.groupMultiselect<string>({
      message: 'Which skills should be installed?',
      options: groups,
      initialValues: initial.filter((name) =>
        available.some((skill) => skill.name === name),
      ),
      required: false,
    }),
  );
}

export async function promptSkillMode(initial: SkillMode): Promise<SkillMode> {
  return unwrap(
    await clack.select<SkillMode>({
      message: 'How should first-party skills be installed?',
      options: [
        {
          value: 'copy',
          label: 'Copy them',
          hint: 'a snapshot that changes only on sync',
        },
        {
          value: 'link',
          label: 'Link them',
          hint: 'edits in skills/ apply right away',
        },
      ],
      initialValue: initial,
    }),
  );
}

export async function promptVariables(
  names: readonly string[],
  defaults: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of names) {
    values[name] = unwrap(
      await clack.text({
        message: variableMessage(name),
        initialValue: defaults[name] ?? '',
        validate: (value) => (value?.trim() ? undefined : 'Required'),
      }),
    ).trim();
  }
  return values;
}

export async function promptLinkCommand(
  initial: boolean,
  paths: Paths,
): Promise<boolean> {
  return unwrap(
    await clack.confirm({
      message: `Link the agents-config command into ${displayPath({ path: paths.localBin, home: paths.home })}?`,
      initialValue: initial,
    }),
  );
}

export async function promptKeepLocal(initial: boolean): Promise<boolean> {
  const choice = unwrap(
    await clack.select<'commit' | 'local'>({
      message: 'Should these files be committed?',
      options: [
        { value: 'commit', label: 'Commit them', hint: 'shared with the repo' },
        {
          value: 'local',
          label: 'Keep them local',
          hint: 'listed in .git/info/exclude',
        },
      ],
      initialValue: initial ? 'local' : 'commit',
    }),
  );
  return choice === 'local';
}

export async function confirmApply(): Promise<boolean> {
  return unwrap(
    await clack.confirm({
      message: 'Apply these changes?',
      initialValue: true,
    }),
  );
}
