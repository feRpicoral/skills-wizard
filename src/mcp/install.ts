import { isDeepStrictEqual } from 'node:util';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import {
  DEFAULT_INDENT,
  isEmptyJsonObject,
  isObject,
  parseJsonObject,
} from '../install/json-merge.ts';
import {
  rawJson,
  removeJsonProperty,
  replaceRawJson,
  setJsonValue,
} from '../install/json-text.ts';
import { isBlank, keepBom, lineEnding, withoutBom } from '../install/lines.ts';
import { removeRegion, upsertRegion } from '../install/managed-region.ts';

export const MCP_TOML_MARKERS = {
  begin: '# BEGIN:agents-config-mcp',
  end: '# END:agents-config-mcp',
} as const;

const mcpDocumentSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

type McpDocument = z.infer<typeof mcpDocumentSchema>;

/**
 * Parses `text` as a JSON object whose optional `mcpServers` key is an object.
 *
 * @throws {JsonMergeError} If the document is not a plain JSON object or
 *   `mcpServers` is not an object.
 */
function parseMcpDocument(text: string | null): McpDocument {
  const result = mcpDocumentSchema.safeParse(parseJsonObject(text));
  if (!result.success) {
    throw new JsonMergeError('"mcpServers" must be an object');
  }

  return result.data;
}

export interface EnsureMcpJsonParams {
  existing: string | null;
  servers: Readonly<Record<string, Record<string, unknown>>>;
  ownedServers: readonly string[];
  retainedServers?: ReadonlySet<string>;
}

export interface EnsureMcpJsonResult {
  content: string;
  servers: string[];
  createdMcpServers: boolean;
  wasEmpty: boolean;
  blankText?: string;
  original?: string;
}

interface EmptyOriginalParams {
  text: string;
  doc: McpDocument;
  createdMcpServers: boolean;
}

/**
 * Captures the raw text of the object that will receive the first managed
 * server, but only when that object is empty, so removal can restore its exact
 * formatting.
 */
function emptyOriginal({
  text,
  doc,
  createdMcpServers,
}: EmptyOriginalParams): string | undefined {
  if (createdMcpServers) {
    return Object.keys(doc).length === 0
      ? rawJson({ text, keys: [] })
      : undefined;
  }

  const currentServers = doc.mcpServers ?? {};
  if (Object.keys(currentServers).length > 0) return undefined;

  return rawJson({ text, keys: ['mcpServers'] });
}

/**
 * Losslessly merges managed MCP server entries under `mcpServers` in a JSON document.
 *
 * Preserves existing formatting, indentation, line endings, UTF-8 BOM, and any
 * unmanaged server keys. Removes previously owned servers that are no longer in
 * `servers` unless they are listed in `retainedServers` (used when multiple tools
 * share the same physical JSON file).
 *
 * @throws {JsonMergeError} If the document is not a plain JSON object, `mcpServers`
 *   is not an object, or an unmanaged server with the same name already exists.
 */
export function ensureMcpJsonServers({
  existing,
  servers,
  ownedServers,
  retainedServers,
}: EnsureMcpJsonParams): EnsureMcpJsonResult {
  const doc = parseMcpDocument(existing);
  const currentServers = doc.mcpServers ?? {};
  const ownedSet = new Set(ownedServers);
  const retainedSet = retainedServers ?? new Set<string>();

  for (const name of Object.keys(servers)) {
    if (Object.hasOwn(currentServers, name) && !ownedSet.has(name)) {
      throw new JsonMergeError(`unmanaged MCP server "${name}" already exists`);
    }
  }

  const createdMcpServers = !Object.hasOwn(doc, 'mcpServers');
  const serverNames = Object.keys(servers);

  if (existing === null || isBlank(existing)) {
    const text = JSON.stringify({ mcpServers: servers }, null, DEFAULT_INDENT);
    const content = keepBom(
      existing ?? '',
      () => `${text}${lineEnding(existing)}`,
    );
    const wasEmpty = existing !== null && isBlank(existing);

    return {
      content,
      servers: serverNames,
      createdMcpServers: true,
      wasEmpty,
      blankText: wasEmpty && existing ? existing : undefined,
    };
  }

  const original = emptyOriginal({
    text: withoutBom(existing),
    doc,
    createdMcpServers,
  });

  let content = existing;
  for (const owned of ownedServers) {
    if (
      !Object.hasOwn(servers, owned) &&
      !retainedSet.has(owned) &&
      Object.hasOwn(currentServers, owned)
    ) {
      content = keepBom(content, (text) =>
        removeJsonProperty({ text, keys: ['mcpServers', owned] }),
      );
    }
  }

  for (const [name, config] of Object.entries(servers)) {
    const unchanged =
      Object.hasOwn(currentServers, name) &&
      isDeepStrictEqual(currentServers[name], config);
    if (!unchanged) {
      content = keepBom(content, (text) =>
        setJsonValue({ text, keys: ['mcpServers', name], value: config }),
      );
    }
  }

  return {
    content,
    servers: serverNames,
    createdMcpServers,
    wasEmpty: false,
    original,
  };
}

export interface RemoveMcpJsonParams {
  existing: string;
  servers: readonly string[];
  createdMcpServers: boolean;
  original?: string;
  retainedServers?: ReadonlySet<string>;
}

/**
 * Removes managed MCP server entries from `mcpServers` in a JSON document,
 * skipping any server names present in `retainedServers`.
 *
 * If `mcpServers` becomes empty after removal, prunes the `mcpServers` key when
 * `createdMcpServers` is true or restores the pre-install `original` raw JSON text.
 *
 * @throws {JsonMergeError} If the document is not a plain JSON object or `mcpServers`
 *   is not an object.
 */
export function removeMcpJsonServers({
  existing,
  servers,
  createdMcpServers,
  original,
  retainedServers,
}: RemoveMcpJsonParams): string {
  const doc = parseMcpDocument(existing);
  if (!Object.hasOwn(doc, 'mcpServers')) return existing;

  const currentServers = doc.mcpServers ?? {};
  const retainedSet = retainedServers ?? new Set<string>();
  const toRemove = servers.filter(
    (name) => !retainedSet.has(name) && Object.hasOwn(currentServers, name),
  );
  if (toRemove.length === 0) return existing;

  let content = existing;
  for (const name of toRemove) {
    content = keepBom(content, (text) =>
      removeJsonProperty({ text, keys: ['mcpServers', name] }),
    );
  }

  const afterDoc = parseJsonObject(content);
  const afterServers = afterDoc.mcpServers;
  if (isObject(afterServers) && Object.keys(afterServers).length === 0) {
    if (createdMcpServers) {
      content = keepBom(content, (text) =>
        removeJsonProperty({ text, keys: ['mcpServers'] }),
      );
      if (
        original !== undefined &&
        isEmptyJsonObject(content) &&
        isEmptyJsonObject(original)
      ) {
        content = keepBom(content, (text) =>
          replaceRawJson({ text, keys: [], raw: original }),
        );
      }
    } else if (original !== undefined) {
      content = keepBom(content, (text) =>
        replaceRawJson({ text, keys: ['mcpServers'], raw: original }),
      );
    }
  }

  return content;
}

interface UnmanagedTomlCheckParams {
  text: string;
  name: string;
}

/**
 * Checks whether `text` defines `mcp_servers.<name>` (via table header, dotted key,
 * inline table, or key inside `[mcp_servers]`).
 *
 * @throws {ManagedRegionError} If `text` is not valid TOML.
 */
export function hasUnmanagedTomlServer({
  text,
  name,
}: UnmanagedTomlCheckParams): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text);
  } catch (error) {
    throw new ManagedRegionError(
      'config.toml is not valid TOML; edit it by hand',
      { cause: error },
    );
  }
  return (
    isObject(parsed.mcp_servers) && Object.hasOwn(parsed.mcp_servers, name)
  );
}

export interface UpsertMcpTomlParams {
  existing: string | null;
  body: string;
  serverNames: readonly string[];
}

/**
 * Upserts the `# BEGIN:agents-config-mcp` managed region in a Codex `config.toml`
 * document after verifying that none of `serverNames` are defined outside the
 * managed region.
 *
 * @throws {ManagedRegionError} If markers are malformed, `config.toml` is invalid
 *   TOML, or an unmanaged server with the same name already exists outside the
 *   managed region.
 */
export function upsertMcpTomlServers({
  existing,
  body,
  serverNames,
}: UpsertMcpTomlParams): string {
  if (existing !== null && !isBlank(existing)) {
    const outside = removeRegion(existing, MCP_TOML_MARKERS);
    for (const name of serverNames) {
      if (hasUnmanagedTomlServer({ text: outside, name })) {
        throw new ManagedRegionError(
          `unmanaged MCP server "${name}" already exists in config.toml`,
        );
      }
    }
  }
  return upsertRegion({ existing, body, markers: MCP_TOML_MARKERS });
}

export function removeMcpTomlServers(existing: string): string {
  return removeRegion(existing, MCP_TOML_MARKERS);
}
