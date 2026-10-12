import { CompositionError } from '../errors.ts';
import {
  type Block,
  type BlockLibrary,
  PLACEHOLDER,
  type Scope,
} from './library.ts';

export type Variables = Readonly<Record<string, string>>;

export function defaultBlockIds(library: BlockLibrary, scope: Scope): string[] {
  return library.blocks
    .filter((block) => block.defaults.includes(scope))
    .map((block) => block.id);
}

export function selectBlocks(
  library: BlockLibrary,
  ids: readonly string[],
  scope: Scope,
): Block[] {
  const known = new Set(library.blocks.map((block) => block.id));
  const unknown = ids.filter((id) => !known.has(id));
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
      block.body.replace(PLACEHOLDER, (_match, name: string) => {
        const value = variables[name];
        if (value === undefined) {
          throw new CompositionError(`Missing variable: ${name}`);
        }
        return value;
      }),
    )
    .join('\n\n');
}

export function composeGlobal(
  library: BlockLibrary,
  ids: readonly string[],
  variables: Variables,
): string {
  const blocks = selectBlocks(library, ids, 'global');
  const rendered = renderBlocks(blocks, variables);
  return `${library.headers.global}\n\n${rendered}\n`;
}

export function composeProject(
  library: BlockLibrary,
  ids: readonly string[],
  variables: Variables,
): string {
  const blocks = selectBlocks(library, ids, 'project');
  return `${renderBlocks(blocks, variables)}\n`;
}
