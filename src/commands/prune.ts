import { outOfScopeBlockIds, unknownBlockIds } from '../blocks/compose.ts';
import type { BlockLibrary, Scope } from '../blocks/library.ts';
import type { Context } from '../context.ts';
import { UsageError } from '../errors.ts';
import {
  type McpCatalog,
  outOfScopeMcpServerNames,
  unknownMcpServerNames,
} from '../mcp/model.ts';
import { isPresetChoice, type PresetChoice } from '../project/presets.ts';
import {
  findSkill,
  type SkillLibrary,
  unknownSkillNames,
} from '../skills/library.ts';
import { notify } from './output.ts';

const BLOCK_REPLACEMENT_SKILLS: Readonly<Record<string, string>> = {
  'git/github-repo-setup': 'github-repo-setup',
  'stack/supabase-prisma': 'supabase-prisma',
};

/**
 * Formats a parenthetical hint pointing to the replacement skill(s) when a
 * deprecated or out-of-scope block ID has a first-party skill equivalent.
 */
export function replacementSkillHint(ids: readonly string[]): string {
  const skills = [
    ...new Set(
      ids
        .map((id) => BLOCK_REPLACEMENT_SKILLS[id])
        .filter((name): name is string => name !== undefined),
    ),
  ];
  if (skills.length === 0) return '';

  return ` (use the ${skills.join(', ')} skill${skills.length === 1 ? '' : 's'} instead)`;
}

export interface DropUnknownPresetParams {
  ctx: Context;
  prompting: boolean;
  preset: string | undefined;
}

/**
 * Validates a recorded manifest `preset` value against `isPresetChoice`,
 * emitting a warning and returning `undefined` when it is no longer recognized.
 */
export function dropUnknownPreset({
  ctx,
  prompting,
  preset,
}: DropUnknownPresetParams): PresetChoice | undefined {
  if (preset === undefined) return undefined;
  if (isPresetChoice(preset)) return preset;

  notify({
    ctx,
    prompting,
    message: `Preset "${preset}" is no longer recognized and was dropped.`,
    level: 'warn',
  });

  return undefined;
}

export interface DropUnavailableBlocksParams {
  ctx: Context;
  prompting: boolean;
  library: BlockLibrary;
  ids: readonly string[];
  scope: Scope;
}

export function dropUnavailableBlocks({
  ctx,
  prompting,
  library,
  ids,
  scope,
}: DropUnavailableBlocksParams): string[] {
  const unknown = unknownBlockIds(library, ids);
  const outOfScope = outOfScopeBlockIds(library, ids, scope);

  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer in the library were dropped: ${unknown.join(', ')}${replacementSkillHint(unknown)}`,
      level: 'warn',
    });
  }

  if (outOfScope.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Blocks no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}${replacementSkillHint(outOfScope)}`,
      level: 'warn',
    });
  }

  return ids.filter((id) => !unknown.includes(id) && !outOfScope.includes(id));
}

export interface DropUnknownSkillsParams {
  ctx: Context;
  prompting: boolean;
  library: SkillLibrary;
  names: readonly string[];
  scope?: Scope;
}

export function dropUnknownSkills({
  ctx,
  prompting,
  library,
  names,
  scope,
}: DropUnknownSkillsParams): string[] {
  const unknown = unknownSkillNames(library, names);
  const outOfScope =
    scope !== undefined
      ? names.filter((name) => {
          const skill = findSkill(library, name);
          return skill !== undefined && !skill.scopes.includes(scope);
        })
      : [];

  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `Skills no longer in catalog.yaml or skills/ were dropped: ${unknown.join(', ')}`,
      level: 'warn',
    });
  }

  if (outOfScope.length > 0 && scope !== undefined) {
    notify({
      ctx,
      prompting,
      message: `Skills no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}`,
      level: 'warn',
    });
  }

  return names.filter(
    (name) => !unknown.includes(name) && !outOfScope.includes(name),
  );
}

export interface DropUnavailableMcpServersParams {
  ctx: Context;
  prompting: boolean;
  catalog: McpCatalog;
  names: readonly string[];
  scope: Scope;
}

export function dropUnavailableMcpServers({
  ctx,
  prompting,
  catalog,
  names,
  scope,
}: DropUnavailableMcpServersParams): string[] {
  const unknown = unknownMcpServerNames(catalog, names);
  const outOfScope = outOfScopeMcpServerNames({ catalog, names, scope });

  if (unknown.length > 0) {
    notify({
      ctx,
      prompting,
      message: `MCP servers no longer in mcp/servers.yaml were dropped: ${unknown.join(', ')}`,
      level: 'warn',
    });
  }

  if (outOfScope.length > 0) {
    notify({
      ctx,
      prompting,
      message: `MCP servers no longer available for ${scope} scope were dropped: ${outOfScope.join(', ')}`,
      level: 'warn',
    });
  }

  return names.filter(
    (name) => !unknown.includes(name) && !outOfScope.includes(name),
  );
}

export interface CheckExplicitMcpParams {
  catalog: McpCatalog;
  names: readonly string[];
  scope: Scope;
}

export function checkExplicitMcp({
  catalog,
  names,
  scope,
}: CheckExplicitMcpParams): void {
  const unknown = unknownMcpServerNames(catalog, names);
  if (unknown.length > 0) {
    throw new UsageError(`Unknown MCP servers: ${unknown.join(', ')}`);
  }

  const outOfScope = outOfScopeMcpServerNames({ catalog, names, scope });
  if (outOfScope.length > 0) {
    throw new UsageError(
      `MCP servers not available for ${scope} scope: ${outOfScope.join(', ')}`,
    );
  }
}
