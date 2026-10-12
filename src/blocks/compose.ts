import { CompositionError } from '../errors.ts';
import {
  type Block,
  type BlockLibrary,
  PLACEHOLDER,
  type Scope,
} from './library.ts';

type Variables = Readonly<Record<string, string>>;

export function defaultBlockIds(library: BlockLibrary, scope: Scope): string[] {
  return library.blocks
    .filter((block) => block.defaults.includes(scope))
    .map((block) => block.id);
}

export function unknownBlockIds(
  library: BlockLibrary,
  ids: readonly string[],
): string[] {
  const known = new Set(library.blocks.map((block) => block.id));
  return ids.filter((id) => !known.has(id));
}

export function withRequirements(
  library: BlockLibrary,
  ids: readonly string[],
): { ids: string[]; added: string[] } {
  const byId = new Map(library.blocks.map((block) => [block.id, block]));
  const wanted = new Set(ids);
  const pending = [...ids];
  while (pending.length > 0) {
    const id = pending.pop();
    for (const required of (id && byId.get(id)?.requires) || []) {
      if (!wanted.has(required)) {
        wanted.add(required);
        pending.push(required);
      }
    }
  }

  const ordered = library.blocks
    .map((block) => block.id)
    .filter((id) => wanted.has(id));
  return { ids: ordered, added: ordered.filter((id) => !ids.includes(id)) };
}

export function selectBlocks(
  library: BlockLibrary,
  ids: readonly string[],
  scope: Scope,
): Block[] {
  const unknown = unknownBlockIds(library, ids);
  if (unknown.length > 0) {
    throw new CompositionError(`Unknown blocks: ${unknown.join(', ')}`);
  }

  const wanted = new Set(ids);
  const selected = library.blocks.filter((block) => wanted.has(block.id));
  const outOfScope = selected.filter((block) => !block.scopes.includes(scope));
  if (outOfScope.length > 0) {
    throw new CompositionError(
      `Blocks not available for ${scope} scope: ${outOfScope.map((block) => block.id).join(', ')}`,
    );
  }
  for (const block of selected) {
    const missing = block.requires.filter((required) => !wanted.has(required));
    if (missing.length > 0) {
      throw new CompositionError(`${block.id} requires ${missing.join(', ')}`);
    }
  }
  return selected;
}

export function requiredVariables(blocks: readonly Block[]): string[] {
  return [...new Set(blocks.flatMap((block) => block.variables))];
}

export function renderBlocks(
  blocks: readonly Block[],
  variables: Variables,
): string {
  const missing = requiredVariables(blocks).filter(
    (name) => !variables[name]?.trim(),
  );
  if (missing.length > 0) {
    throw new CompositionError(`Missing variables: ${missing.join(', ')}`);
  }

  return blocks
    .map((block) =>
      block.body.replace(
        PLACEHOLDER,
        (match, name: string) => variables[name] ?? match,
      ),
    )
    .join('\n\n');
}

export function composeGlobal(
  library: BlockLibrary,
  ids: readonly string[],
  variables: Variables,
): string {
  const blocks = selectBlocks(library, ids, 'global');
  return `${library.headers.global}\n\n${renderBlocks(blocks, variables)}\n`;
}

export function composeProject(
  library: BlockLibrary,
  ids: readonly string[],
  variables: Variables,
): string {
  const blocks = selectBlocks(library, ids, 'project');
  return `${renderBlocks(blocks, variables)}\n`;
}
