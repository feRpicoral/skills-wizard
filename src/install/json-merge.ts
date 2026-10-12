import { JsonMergeError } from '../errors.ts';

export type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(
  content: string | null,
  file: string,
): JsonObject {
  if (content === null || content.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new JsonMergeError(
      `${file} is not plain JSON (comments or syntax errors); edit it by hand`,
      { cause: error },
    );
  }
  if (!isObject(parsed)) {
    throw new JsonMergeError(`${file} must contain a JSON object`);
  }
  return parsed;
}

function parentOf(
  doc: JsonObject,
  keyPath: string,
  file: string,
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
      throw new JsonMergeError(`${file}: "${key}" is not an object`);
    }
  }
  return { parent: current, key: last };
}

function stringValues(value: unknown, keyPath: string, file: string): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  throw new JsonMergeError(
    `${file}: "${keyPath}" must be a string or a list of strings`,
  );
}

export function ensureArrayValues(
  doc: JsonObject,
  keyPath: string,
  values: readonly string[],
  file: string,
): { doc: JsonObject; added: string[] } {
  const next = structuredClone(doc);
  const location = parentOf(next, keyPath, file, true);
  if (!location) throw new JsonMergeError(`invalid key path "${keyPath}"`);

  const current = stringValues(location.parent[location.key], keyPath, file);
  const added = values.filter((value) => !current.includes(value));
  location.parent[location.key] = [...current, ...added];
  return { doc: next, added };
}

export function hasArrayValues(
  doc: JsonObject,
  keyPath: string,
  values: readonly string[],
  file: string,
): boolean {
  const location = parentOf(doc, keyPath, file, false);
  if (!location) return false;
  const current = stringValues(location.parent[location.key], keyPath, file);
  return values.every((value) => current.includes(value));
}

export function removeArrayValues(
  doc: JsonObject,
  keyPath: string,
  values: readonly string[],
  file: string,
): JsonObject {
  const next = structuredClone(doc);
  const location = parentOf(next, keyPath, file, false);
  if (!location) return next;

  const remaining = stringValues(
    location.parent[location.key],
    keyPath,
    file,
  ).filter((value) => !values.includes(value));
  if (remaining.length > 0) {
    location.parent[location.key] = remaining;
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

export function serializeJson(doc: JsonObject): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
