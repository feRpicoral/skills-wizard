import { JsonMergeError, ManagedRegionError } from '../errors.ts';
import { parseJsonObject } from '../install/json-merge.ts';
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

const DEFAULT_INDENT = 2;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EnsureMcpJsonParams {
  existing: string | null;
  servers: Readonly<Record<string, Record<string, unknown>>>;
  ownedServers: readonly string[];
}

export interface EnsureMcpJsonResult {
  content: string;
  servers: string[];
  createdMcpServers: boolean;
  wasEmpty: boolean;
  blankText?: string;
  original?: string;
}

export function ensureMcpJsonServers({
  existing,
  servers,
  ownedServers,
}: EnsureMcpJsonParams): EnsureMcpJsonResult {
  const doc = parseJsonObject(existing);
  if (doc.mcpServers !== undefined && !isObject(doc.mcpServers)) {
    throw new JsonMergeError('"mcpServers" must be an object');
  }
  const currentServers = doc.mcpServers ?? {};
  const ownedSet = new Set(ownedServers);

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
      ...(wasEmpty && existing ? { blankText: existing } : {}),
    };
  }

  const original =
    !createdMcpServers && Object.keys(currentServers).length === 0
      ? rawJson({ text: withoutBom(existing), keys: ['mcpServers'] })
      : undefined;

  let content = existing;
  for (const owned of ownedServers) {
    if (
      !Object.hasOwn(servers, owned) &&
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
      JSON.stringify(currentServers[name]) === JSON.stringify(config);
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
    ...(original !== undefined ? { original } : {}),
  };
}

export interface RemoveMcpJsonParams {
  existing: string;
  servers: readonly string[];
  createdMcpServers: boolean;
  original?: string;
}

export function removeMcpJsonServers({
  existing,
  servers,
  createdMcpServers,
  original,
}: RemoveMcpJsonParams): string {
  const doc = parseJsonObject(existing);
  if (!Object.hasOwn(doc, 'mcpServers')) return existing;
  if (doc.mcpServers !== undefined && !isObject(doc.mcpServers)) {
    throw new JsonMergeError('"mcpServers" must be an object');
  }
  const currentServers = doc.mcpServers ?? {};
  const toRemove = servers.filter((name) =>
    Object.hasOwn(currentServers, name),
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

export function hasUnmanagedTomlServer({
  text,
  name,
}: UnmanagedTomlCheckParams): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^[ \\t]*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|"${escaped}"|'${escaped}')(?:\\s*\\.[^\\]]*)?\\s*\\]`,
    'm',
  );
  return pattern.test(text);
}

export interface UpsertMcpTomlParams {
  existing: string | null;
  body: string;
  serverNames: readonly string[];
}

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
