import { JsonMergeError } from '../errors.ts';

export type JsonObject = Record<string, unknown>;

const DEFAULT_INDENT = 2;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(content: string | null): JsonObject {
  if (content === null || content.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new JsonMergeError(
      'not plain JSON (comments or syntax errors); edit it by hand',
      { cause: error },
    );
  }
  if (!isObject(parsed)) {
    throw new JsonMergeError('must contain a JSON object');
  }
  return parsed;
}

function locate(
  doc: JsonObject,
  keyPath: string,
  create: boolean,
): { parent: JsonObject; key: string } | null {
  const keys = keyPath.split('.');
  const last = keys.pop();
  if (!last) throw new JsonMergeError(`invalid key path "${keyPath}"`);

  let current = doc;
  for (const key of keys) {
    const next = current[key];
    if (next === undefined && create) {
      const created: JsonObject = {};
      current[key] = created;
      current = created;
    } else if (isObject(next)) {
      current = next;
    } else if (next === undefined) {
      return null;
    } else {
      throw new JsonMergeError(`"${key}" is not an object`);
    }
  }
  return { parent: current, key: last };
}

function stringValues(value: unknown, keyPath: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  throw new JsonMergeError(
    `"${keyPath}" must be a string or a list of strings`,
  );
}

export interface EnsureResult {
  doc: JsonObject;
  added: string[];
  wasString: boolean;
}

export function ensureArrayValues(
  doc: JsonObject,
  keyPath: string,
  values: readonly string[],
): EnsureResult {
  const next = structuredClone(doc);
  const location = locate(next, keyPath, true);
  if (!location) throw new JsonMergeError(`invalid key path "${keyPath}"`);

  const original = location.parent[location.key];
  const current = stringValues(original, keyPath);
  const added = values.filter((value) => !current.includes(value));
  if (added.length > 0) location.parent[location.key] = [...current, ...added];
  return { doc: next, added, wasString: typeof original === 'string' };
}

export function removeArrayValues(
  doc: JsonObject,
  keyPath: string,
  values: readonly string[],
  restoreString: boolean,
): JsonObject {
  const next = structuredClone(doc);
  const location = locate(next, keyPath, false);
  if (!location) return next;

  const remaining = stringValues(location.parent[location.key], keyPath).filter(
    (value) => !values.includes(value),
  );
  if (remaining.length > 0) {
    location.parent[location.key] =
      restoreString && remaining.length === 1 ? remaining[0] : remaining;
    return next;
  }

  delete location.parent[location.key];
  return pruneEmptyObjects(next, keyPath.split('.').slice(0, -1));
}

function pruneEmptyObjects(doc: JsonObject, keys: string[]): JsonObject {
  for (let depth = keys.length; depth > 0; depth -= 1) {
    const path = keys.slice(0, depth);
    let parent: JsonObject = doc;
    for (const key of path.slice(0, -1)) {
      const next = parent[key];
      if (!isObject(next)) return doc;
      parent = next;
    }
    const leafKey = path.at(-1);
    if (leafKey === undefined) return doc;
    const leaf = parent[leafKey];
    if (!isObject(leaf) || Object.keys(leaf).length > 0) return doc;
    delete parent[leafKey];
  }
  return doc;
}

function detectIndent(content: string | null): string | number {
  const match = content ? /^([ \t]+)"/m.exec(content) : null;
  return match?.[1] ?? DEFAULT_INDENT;
}

export function serializeJson(
  doc: JsonObject,
  existing: string | null,
): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(doc, null, detectIndent(existing));
  return `${text.replace(/\n/g, eol)}${eol}`;
}
