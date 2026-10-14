import { isDeepStrictEqual } from 'node:util';

import { getProperty, hasProperty, parsePath } from 'dot-prop';
import type { JSONPath } from 'jsonc-parser';

import { JsonMergeError } from '../errors.ts';
import type { ManifestEntry } from '../state/manifest.ts';
import {
  appendArrayElements,
  rawJson,
  removeArrayElements,
  removeJsonProperty,
  replaceRawJson,
  setJsonValue,
} from './json-text.ts';
import { isBlank, keepBom, lineEnding, withoutBom } from './lines.ts';
import {
  conflict,
  type FileActionParams,
  type PlannedAction,
  writeAction,
} from './safety.ts';
import type { JsonArrayTarget } from './targets.ts';

type JsonObject = Record<string, unknown>;

export const DEFAULT_INDENT = 2;

export function isObject(value: unknown): value is JsonObject {
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
  ownedValues?: readonly string[];
}

interface EnsureResult {
  content: string;
  added: string[];
  wasString: boolean;
  wasEmpty: boolean;
  /** The whitespace a blank file held, so removal can put it back. */
  blankText?: string;
  createdKeys: number;
  original?: string;
}

interface UpdateArrayValuesParams {
  existing: string | null;
  keys: JSONPath;
  current: readonly string[];
  stale: readonly string[];
  added: readonly string[];
  appendable: boolean;
}

function updateArrayValues({
  existing,
  keys,
  current,
  stale,
  added,
  appendable,
}: UpdateArrayValuesParams): string {
  const remaining = current.filter((item) => !stale.includes(item));
  if (existing !== null && !isBlank(existing) && appendable) {
    let content = existing;
    if (stale.length > 0) {
      content = keepBom(content, (text) =>
        removeArrayElements({ text, keys, values: stale }),
      );
    }
    if (added.length > 0) {
      content = keepBom(content, (text) =>
        appendArrayElements({ text, keys, values: added }),
      );
    }
    return content;
  }
  return setValue({ existing, keys, value: [...remaining, ...added] });
}

interface OriginalParams {
  existing: string;
  keys: JSONPath;
  createdKeys: number;
}

function originalText({
  existing,
  keys,
  createdKeys,
}: OriginalParams): string | undefined {
  const raw = rawJson({
    text: withoutBom(existing),
    keys: keys.slice(0, keys.length - createdKeys),
  });
  if (raw === undefined) return undefined;
  if (createdKeys === 0) return raw;
  return Object.keys(JSON.parse(raw) as JsonObject).length === 0
    ? raw
    : undefined;
}

/**
 * Ensures `values` are present in the string or string-array property at
 * `keyPath` while preserving surrounding JSON formatting, indentation, line
 * endings, and UTF-8 BOM.
 *
 * Returns the updated JSON text along with rollback provenance (`added`,
 * `wasString`, `wasEmpty`, `blankText`, `createdKeys`, `original`) so
 * {@link removeArrayValues} can restore the file's prior shape on removal.
 */
export function ensureArrayValues({
  existing,
  keyPath,
  values,
  ownedValues = [],
}: EnsureArrayValuesParams): EnsureResult {
  const doc = parseJsonObject(existing);
  const keys = parseKeyPath(doc, keyPath);
  const original = getProperty(doc, keys);
  const current = stringValues(original, keyPath);
  const stale = ownedValues.filter(
    (value) => !values.includes(value) && current.includes(value),
  );
  const remaining = current.filter((value) => !stale.includes(value));
  const added = values.filter((value) => !remaining.includes(value));
  const createdKeys = added.length > 0 ? missingKeys(doc, keys) : 0;
  const changed = stale.length > 0 || added.length > 0 || existing === null;
  const content = changed
    ? updateArrayValues({
        existing,
        keys,
        current,
        stale,
        added,
        appendable: Array.isArray(original),
      })
    : existing;
  const raw =
    added.length > 0 && existing !== null && !isBlank(existing)
      ? originalText({ existing, keys, createdKeys })
      : undefined;
  const wasEmpty = added.length > 0 && existing !== null && isBlank(existing);
  return {
    content,
    added,
    wasString: typeof original === 'string',
    wasEmpty,
    ...(wasEmpty && existing ? { blankText: existing } : {}),
    createdKeys,
    ...(raw === undefined ? {} : { original: raw }),
  };
}

function normalizedValue(value: unknown): unknown {
  return typeof value === 'string' ? [value] : value;
}

interface RestoreOriginalParams {
  content: string;
  keys: JSONPath;
  original: string;
}

function restoreOriginal({
  content,
  keys,
  original,
}: RestoreOriginalParams): string {
  return keepBom(content, (text) => {
    const raw = rawJson({ text, keys });
    if (raw === undefined) return text;
    const same = isDeepStrictEqual(
      normalizedValue(JSON.parse(raw)),
      normalizedValue(JSON.parse(original)),
    );
    return same ? replaceRawJson({ text, keys, raw: original }) : text;
  });
}

interface RemoveArrayValuesParams {
  existing: string;
  keyPath: string;
  values: readonly string[];
  restoreString: boolean;
  createdKeys: number;
  original?: string;
}

function pruneCreated({ existing, keys, createdKeys }: OriginalParams): string {
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

/**
 * Removes `values` from the string or string-array property at `keyPath` and
 * restores the file's pre-install shape using the provenance captured by
 * {@link ensureArrayValues} (`restoreString`, `createdKeys`, `original`).
 *
 * Prunes up to `createdKeys` empty ancestor objects that were created on
 * install, converts a single remaining element back to a string when
 * `restoreString` is true, and restores `original` verbatim when the remaining
 * value matches the pre-install value.
 */
export function removeArrayValues({
  existing,
  keyPath,
  values,
  restoreString,
  createdKeys,
  original,
}: RemoveArrayValuesParams): string {
  const doc = parseJsonObject(existing);
  const keys = parseKeyPath(doc, keyPath);
  if (!hasProperty(doc, keys)) return existing;

  const value = getProperty(doc, keys);
  const current = stringValues(value, keyPath);
  const remaining = current.filter((item) => !values.includes(item));
  if (remaining.length === current.length) return existing;

  let content: string;
  if (remaining.length === 0 && createdKeys > 0) {
    content = pruneCreated({ existing, keys, createdKeys });
  } else if (Array.isArray(value)) {
    content = keepBom(existing, (text) =>
      removeArrayElements({ text, keys, values }),
    );
    if (restoreString && remaining.length === 1 && original === undefined) {
      content = setValue({ existing: content, keys, value: remaining[0] });
    }
  } else {
    content = setValue({ existing, keys, value: remaining });
  }
  return original === undefined
    ? content
    : restoreOriginal({
        content,
        keys: keys.slice(0, keys.length - createdKeys),
        original,
      });
}

interface LegacyCreatedKeysParams {
  keyPath: string;
  createdFile: boolean;
}

export function legacyCreatedKeys({
  keyPath,
  createdFile,
}: LegacyCreatedKeysParams): number {
  return createdFile ? parsePath(keyPath).length : 1;
}

export function isEmptyJsonObject(content: string): boolean {
  return Object.keys(parseJsonObject(content)).length === 0;
}

export interface EmptyJsonState {
  wasEmpty?: true;
  blankText?: string;
  rootOriginal?: string;
}

type JsonArrayEntry = Extract<ManifestEntry, { kind: 'json-array' }>;

interface CreatedShape {
  createdKeys?: number;
  original?: string;
}

function shapeOf({ createdKeys, original }: CreatedShape): CreatedShape {
  return {
    ...(createdKeys === undefined ? {} : { createdKeys }),
    ...(original === undefined ? {} : { original }),
  };
}

interface CreatedShapeParams {
  earlier: JsonArrayEntry | null;
  result: EnsureResult;
}

function createdShape({ earlier, result }: CreatedShapeParams): CreatedShape {
  if (!earlier) return shapeOf(result);
  if (earlier.createdKeys === undefined) {
    return result.createdKeys > 0 ? shapeOf(result) : {};
  }
  return shapeOf(result.createdKeys > earlier.createdKeys ? result : earlier);
}

export interface PlanJsonArrayParams extends FileActionParams<JsonArrayTarget> {
  emptyJson?: EmptyJsonState;
}

export function planJsonArray({
  target,
  file,
  previous,
  emptyJson,
}: PlanJsonArrayParams): PlannedAction {
  try {
    const earlier =
      file.existing !== null && previous?.kind === 'json-array'
        ? previous
        : null;
    const result = ensureArrayValues({
      existing: file.existing,
      keyPath: target.key,
      values: target.values,
      ...(earlier ? { ownedValues: earlier.added } : {}),
    });
    const added = [
      ...new Set([
        ...(earlier?.added ?? []).filter((value) =>
          target.values.includes(value),
        ),
        ...result.added,
      ]),
    ];
    const wasEmpty = earlier
      ? earlier.wasEmpty
      : (emptyJson?.wasEmpty ?? result.wasEmpty);
    const blankText = earlier
      ? earlier.blankText
      : (emptyJson?.blankText ?? result.blankText);
    const shape = createdShape({ earlier, result });
    const effectiveShape =
      !earlier &&
      shape.original === undefined &&
      emptyJson?.rootOriginal !== undefined
        ? {
            createdKeys: parsePath(target.key).length,
            original: emptyJson.rootOriginal,
          }
        : shape;
    return writeAction({
      target,
      file,
      next: result.content,
      entry: {
        kind: 'json-array',
        path: target.path,
        key: target.key,
        added,
        wasString: earlier?.wasString ?? result.wasString,
        ...effectiveShape,
        ...(wasEmpty ? { wasEmpty: true } : {}),
        ...(blankText !== undefined ? { blankText } : {}),
        createdFile: file.createdFile,
      },
      previous,
    });
  } catch (error) {
    if (error instanceof JsonMergeError) {
      return conflict({ target, previous, reason: error.message });
    }
    throw error;
  }
}
