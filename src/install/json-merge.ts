import { getProperty, hasProperty, parsePath } from 'dot-prop';
import type { JSONPath } from 'jsonc-parser';

import { JsonMergeError } from '../errors.ts';
import { removeJsonProperty, setJsonValue } from './json-text.ts';
import { isBlank, keepBom, lineEnding, withoutBom } from './lines.ts';

type JsonObject = Record<string, unknown>;

const DEFAULT_INDENT = 2;

export const LEGACY_CREATED_KEYS = 1;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(content: string | null): JsonObject {
  if (content === null || isBlank(content)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutBom(content));
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

function parseKeyPath(doc: JsonObject, keyPath: string): JSONPath {
  const keys = parsePath(keyPath);
  if (keys.length === 0) {
    throw new JsonMergeError(`invalid key path "${keyPath}"`);
  }
  for (let depth = 1; depth < keys.length; depth += 1) {
    const ancestor = getProperty(doc, keys.slice(0, depth));
    if (ancestor !== undefined && !isObject(ancestor)) {
      throw new JsonMergeError(`"${String(keys[depth - 1])}" is not an object`);
    }
  }
  return keys;
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

function missingKeys(doc: JsonObject, keys: JSONPath): number {
  let depth = keys.length;
  while (depth > 0 && !hasProperty(doc, keys.slice(0, depth))) depth -= 1;
  return keys.length - depth;
}

interface SetValueParams {
  existing: string | null;
  keys: JSONPath;
  value: unknown;
}

function setValue({ existing, keys, value }: SetValueParams): string {
  if (existing === null || isBlank(existing)) {
    const doc = keys.reduceRight<unknown>(
      (inner, key) => ({ [String(key)]: inner }),
      value,
    );
    const text = JSON.stringify(doc, null, DEFAULT_INDENT);
    return keepBom(existing ?? '', () => `${text}${lineEnding(existing)}`);
  }
  return keepBom(existing, (text) => setJsonValue({ text, keys, value }));
}

interface RemoveKeyParams {
  existing: string;
  keys: JSONPath;
}

function removeKey({ existing, keys }: RemoveKeyParams): string {
  return keepBom(existing, (text) => removeJsonProperty({ text, keys }));
}

interface EnsureArrayValuesParams {
  existing: string | null;
  keyPath: string;
  values: readonly string[];
}

interface EnsureResult {
  content: string;
  added: string[];
  wasString: boolean;
  createdKeys: number;
}

export function ensureArrayValues({
  existing,
  keyPath,
  values,
}: EnsureArrayValuesParams): EnsureResult {
  const doc = parseJsonObject(existing);
  const keys = parseKeyPath(doc, keyPath);
  const original = getProperty(doc, keys);
  const current = stringValues(original, keyPath);
  const added = values.filter((value) => !current.includes(value));
  const content =
    added.length > 0 || existing === null
      ? setValue({ existing, keys, value: [...current, ...added] })
      : existing;
  return {
    content,
    added,
    wasString: typeof original === 'string',
    createdKeys: added.length > 0 ? missingKeys(doc, keys) : 0,
  };
}

interface RemoveArrayValuesParams {
  existing: string;
  keyPath: string;
  values: readonly string[];
  restoreString: boolean;
  createdKeys: number;
}

export function removeArrayValues({
  existing,
  keyPath,
  values,
  restoreString,
  createdKeys,
}: RemoveArrayValuesParams): string {
  const doc = parseJsonObject(existing);
  const keys = parseKeyPath(doc, keyPath);
  if (!hasProperty(doc, keys)) return existing;

  const current = stringValues(getProperty(doc, keys), keyPath);
  const remaining = current.filter((value) => !values.includes(value));
  if (remaining.length === current.length) return existing;
  if (remaining.length > 0 || createdKeys === 0) {
    const value =
      restoreString && remaining.length === 1 ? remaining[0] : remaining;
    return setValue({ existing, keys, value });
  }

  let content = removeKey({ existing, keys });
  const existingDepth = keys.length - createdKeys;
  for (let depth = keys.length - 1; depth > existingDepth; depth -= 1) {
    const ancestorPath = keys.slice(0, depth);
    const ancestor = getProperty(parseJsonObject(content), ancestorPath);
    if (!isObject(ancestor) || Object.keys(ancestor).length > 0) break;
    content = removeKey({ existing: content, keys: ancestorPath });
  }
  return content;
}

export function isEmptyJsonObject(content: string): boolean {
  return Object.keys(parseJsonObject(content)).length === 0;
}
