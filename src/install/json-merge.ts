import detectIndent from 'detect-indent';
import {
  deleteProperty,
  getProperty,
  hasProperty,
  parsePath,
  setProperty,
} from 'dot-prop';

import { JsonMergeError } from '../errors.ts';
import { lineEnding } from './lines.ts';

type JsonObject = Record<string, unknown>;

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

function parseKeyPath(
  doc: JsonObject,
  keyPath: string,
): Array<string | number> {
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

interface EnsureArrayValuesParams {
  doc: JsonObject;
  keyPath: string;
  values: readonly string[];
}

interface EnsureResult {
  doc: JsonObject;
  added: string[];
  wasString: boolean;
}

export function ensureArrayValues({
  doc,
  keyPath,
  values,
}: EnsureArrayValuesParams): EnsureResult {
  const next = structuredClone(doc);
  const keys = parseKeyPath(next, keyPath);
  const original = getProperty(next, keys);
  const current = stringValues(original, keyPath);
  const added = values.filter((value) => !current.includes(value));
  if (added.length > 0) setProperty(next, keys, [...current, ...added]);
  return { doc: next, added, wasString: typeof original === 'string' };
}

interface RemoveArrayValuesParams {
  doc: JsonObject;
  keyPath: string;
  values: readonly string[];
  restoreString: boolean;
}

export function removeArrayValues({
  doc,
  keyPath,
  values,
  restoreString,
}: RemoveArrayValuesParams): JsonObject {
  const next = structuredClone(doc);
  const keys = parseKeyPath(next, keyPath);
  if (!hasProperty(next, keys)) return next;

  const remaining = stringValues(getProperty(next, keys), keyPath).filter(
    (value) => !values.includes(value),
  );
  if (remaining.length > 0) {
    setProperty(
      next,
      keys,
      restoreString && remaining.length === 1 ? remaining[0] : remaining,
    );
    return next;
  }

  deleteProperty(next, keys);
  for (let depth = keys.length - 1; depth > 0; depth -= 1) {
    const ancestorPath = keys.slice(0, depth);
    const ancestor = getProperty(next, ancestorPath);
    if (!isObject(ancestor) || Object.keys(ancestor).length > 0) break;
    deleteProperty(next, ancestorPath);
  }
  return next;
}

export function serializeJson(
  doc: JsonObject,
  existing: string | null,
): string {
  const eol = lineEnding(existing);
  const indent = existing
    ? detectIndent(existing).indent || DEFAULT_INDENT
    : DEFAULT_INDENT;
  const text = JSON.stringify(doc, null, indent);
  return `${text.replace(/\n/g, eol)}${eol}`;
}
