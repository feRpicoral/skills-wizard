import {
  defaultBlockIds,
  outOfScopeBlockIds,
  requiredVariables,
  selectBlocks,
  unknownBlockIds,
  withRequirements,
} from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import { lookupVariables } from '../blocks/variables.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import {
  applyReRunPresetAndStyle,
  applyReRunPresetSkills,
  type PresetChoice,
  type PresetDefinition,
  type ProjectStyle,
  type ResolvedPresetSelection,
} from '../project/presets.ts';
import {
  promptBlocks,
  promptKeepLocal,
  promptLinkCommand,
  promptSkillMode,
  promptSkills,
  promptTools,
  promptVariables,
} from '../prompts/selection.ts';
import { DEFAULT_SKILL_MODE, type SkillMode } from '../skills/install.ts';
import {
  defaultSkillNames,
  findSkill,
  type SkillLibrary,
} from '../skills/library.ts';
import type { Manifest } from '../state/manifest.ts';
import { detectTools } from '../tools/detect.ts';
import type { ToolId } from '../tools/registry.ts';
import {
  dropUnknownSkills,
  type Location,
  notify,
  notifyLeftGit,
  notifyReconciledBlocks,
  type ReconciledManifest,
} from './shared.ts';
import { checkExplicitSkills } from './skill-shared.ts';

function checkExplicitBlocks(
  library: BlockLibrary,
  ids: readonly string[],
  scope: Scope,
): void {
  const unknown = unknownBlockIds(library, ids);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown blocks: ${unknown.join(', ')}`);
  }
  const outOfScope = outOfScopeBlockIds(library, ids, scope);
  if (outOfScope.length > 0) {
    throw new UsageError(
      `Blocks not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
}

export interface ResolveToolsSelectionParams {
  ctx: Context;
  scope: Scope;
  prompting: boolean;
  requestedTools?: ToolId[];
  previous: Manifest | null;
}

export async function resolveToolsSelection({
  ctx,
  scope,
  prompting,
  requestedTools,
  previous,
}: ResolveToolsSelectionParams): Promise<ToolId[]> {
  const initial =
    requestedTools ??
    previous?.tools ??
    (await detectTools(ctx.paths, ctx.searchPath));
  const tools = prompting
    ? await promptTools({ scope, initial, paths: ctx.paths })
    : initial;
  if (!prompting && tools.length === 0 && !previous) {
    throw new UsageError('No tools selected or detected; pass --tools <ids>.');
  }
  return tools;
}

export interface ResolveBlocksSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  prompting: boolean;
  requestedBlocks?: string[];
  preset?: PresetChoice;
  style?: ProjectStyle;
  presetChanged: boolean;
  styleChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition;
  reconciled: ReconciledManifest | null;
}

export async function resolveBlocksSelection({
  ctx,
  library,
  scope,
  prompting,
  requestedBlocks,
  preset,
  style,
  presetChanged,
  styleChanged,
  presetSelection,
  replacedPreset,
  reconciled,
}: ResolveBlocksSelectionParams): Promise<string[]> {
  if (requestedBlocks) checkExplicitBlocks(library, requestedBlocks, scope);
  if (!requestedBlocks && reconciled) {
    notifyReconciledBlocks({
      ctx,
      prompting,
      scope,
      reconciled:
        prompting || presetSelection !== null
          ? { ...reconciled, addedBlocks: [] }
          : reconciled,
    });
    if (!prompting && presetSelection === null) return reconciled.blocks;
  }
  const reRunBlocks =
    reconciled !== null && presetSelection !== null
      ? applyReRunPresetAndStyle({
          library,
          recordedBlocks: reconciled.knownBlocks,
          previousPresetBlocks: replacedPreset?.blocks ?? [],
          presetBlocks: presetChanged ? presetSelection.blocks : [],
          requestedStyle: styleChanged ? style : undefined,
        })
      : null;
  const initial =
    requestedBlocks ??
    (reRunBlocks !== null
      ? prompting && preset === 'none' && reRunBlocks.length === 0
        ? defaultBlockIds(library, scope)
        : reRunBlocks
      : reconciled !== null
        ? reconciled.knownBlocks
        : presetSelection !== null && presetSelection.blocks.length > 0
          ? presetSelection.blocks
          : defaultBlockIds(library, scope));
  const chosen = prompting
    ? await promptBlocks({ library, scope, initial })
    : initial;
  const { ids: blocks, added } = withRequirements(library, chosen);
  if (added.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Added required blocks: ${added.join(', ')}`,
    });
  }
  return blocks;
}

export interface ResolveVariablesSelectionParams {
  ctx: Context;
  library: BlockLibrary;
  scope: Scope;
  blocks: readonly string[];
  prompting: boolean;
  givenVariables: Readonly<Record<string, string>>;
  previous: Manifest | null;
  reconciled: ReconciledManifest | null;
}

export async function resolveVariablesSelection({
  ctx,
  library,
  scope,
  blocks,
  prompting,
  givenVariables,
  previous,
  reconciled,
}: ResolveVariablesSelectionParams): Promise<Record<string, string>> {
  const needed = requiredVariables(selectBlocks(library, blocks, scope));
  const unused = Object.keys(givenVariables).filter(
    (name) => !needed.includes(name),
  );
  if (unused.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Ignoring unused variables: ${unused.join(', ')}`,
      level: 'warn',
    });
  }
  const known = await lookupVariables(
    needed,
    {
      ...previous?.variables,
      ...reconciled?.foundVariables,
      ...givenVariables,
    },
    { home: ctx.paths.home, searchPath: ctx.searchPath },
  );
  const variables = prompting ? await promptVariables(needed, known) : known;
  const missing = needed.filter((name) => !variables[name]?.trim());
  if (missing.length > 0) {
    throw new UsageError(
      `Missing variables: ${missing.map((name) => `--var ${name}=<value>`).join(' ')}`,
    );
  }
  return variables;
}

export interface ResolveInstallOptionsParams {
  ctx: Context;
  scope: Scope;
  location: Location;
  prompting: boolean;
  requestedLinkCommand?: boolean;
  requestedKeepLocal?: boolean;
  previous: Manifest | null;
  reconciled: ReconciledManifest | null;
}

export async function resolveInstallOptions({
  ctx,
  scope,
  location,
  prompting,
  requestedLinkCommand,
  requestedKeepLocal,
  previous,
  reconciled,
}: ResolveInstallOptionsParams): Promise<{
  linkCommand: boolean;
  keepLocal: boolean;
}> {
  const previousLink = previous?.options.linkCommand ?? false;
  const linkCommand =
    scope === 'global'
      ? (requestedLinkCommand ??
        (prompting
          ? await promptLinkCommand(previous ? previousLink : true, ctx.paths)
          : previousLink))
      : false;
  const git = location.project?.git;
  if (requestedKeepLocal && !git) {
    throw new UsageError(
      `${location.project?.dir ?? ctx.cwd} is not in a git repository, so files cannot be kept local.`,
    );
  }
  if (
    reconciled?.leftGit &&
    location.project &&
    requestedKeepLocal === undefined
  ) {
    notifyLeftGit({ ctx, prompting, projectDir: location.project.dir });
  }
  const previousLocal = reconciled?.keepLocal ?? false;
  const keepLocal =
    scope === 'project' && git
      ? (requestedKeepLocal ??
        (prompting ? await promptKeepLocal(previousLocal) : previousLocal))
      : false;
  return { linkCommand, keepLocal };
}

export interface ResolveSkillsSelectionParams {
  ctx: Context;
  skillLibrary: SkillLibrary;
  scope: Scope;
  prompting: boolean;
  requestedSkills?: string[];
  requestedSkillMode?: SkillMode;
  presetChanged: boolean;
  presetSelection: ResolvedPresetSelection | null;
  replacedPreset?: PresetDefinition;
  previous: Manifest | null;
}

export async function resolveSkillsSelection({
  ctx,
  skillLibrary,
  scope,
  prompting,
  requestedSkills,
  requestedSkillMode,
  presetChanged,
  presetSelection,
  replacedPreset,
  previous,
}: ResolveSkillsSelectionParams): Promise<{
  skills: string[];
  skillMode: SkillMode;
}> {
  if (requestedSkills) {
    checkExplicitSkills(skillLibrary, requestedSkills, scope);
  }
  const recordedSkills = previous
    ? dropUnknownSkills({
        ctx,
        prompting,
        library: skillLibrary,
        names: previous.skills,
        scope,
      })
    : null;
  const initialSkills =
    requestedSkills ??
    (recordedSkills !== null
      ? presetChanged && presetSelection !== null
        ? applyReRunPresetSkills({
            recordedSkills,
            previousPresetSkills: replacedPreset?.skills ?? [],
            presetSkills: presetSelection.skills,
          })
        : recordedSkills
      : presetSelection !== null
        ? presetSelection.skills
        : defaultSkillNames(skillLibrary, scope));
  const skills = prompting
    ? await promptSkills(skillLibrary, scope, initialSkills)
    : initialSkills;
  const previousMode = previous?.options.skillMode ?? DEFAULT_SKILL_MODE;
  const firstParty = skills.some(
    (name) => findSkill(skillLibrary, name)?.origin.type === 'local',
  );
  const skillMode =
    scope === 'global'
      ? (requestedSkillMode ??
        (prompting && firstParty
          ? await promptSkillMode(previousMode)
          : previousMode))
      : DEFAULT_SKILL_MODE;
  return { skills, skillMode };
}
