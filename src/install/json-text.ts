import detectIndent from 'detect-indent';
import {
  applyEdits,
  findNodeAtLocation,
  format,
  type FormattingOptions,
  type JSONPath,
  modify,
  type Node,
  parseTree,
} from 'jsonc-parser';

import { JsonMergeError } from '../errors.ts';
import { isBlank, lineEnding, withoutBom } from './lines.ts';

export type JsonObject = Record<string, unknown>;

const DEFAULT_INDENT = '  ';

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

export function isEmptyJsonObject(content: string): boolean {
  return Object.keys(parseJsonObject(content)).length === 0;
}

function formattingOptions(text: string): FormattingOptions {
  const { indent, type } = detectIndent(text);
  const unit = indent || DEFAULT_INDENT;
  return {
    insertSpaces: type !== 'tab',
    tabSize: type === 'tab' ? 1 : unit.length,
    eol: lineEnding(text || null),
  };
}

function rootObject(text: string): Node {
  const root = parseTree(text);
  if (root?.type !== 'object') {
    throw new JsonMergeError('must contain a JSON object');
  }
  return root;
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

function isInline(text: string, node: Node): boolean {
  return !text.slice(node.offset, node.offset + node.length).includes('\n');
}

function inlineJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => inlineJson(item)).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value).map(
      ([key, item]) => `${JSON.stringify(key)}: ${inlineJson(item)}`,
    );
    return `{ ${members.join(', ')} }`;
  }
  return JSON.stringify(value);
}

function nearestObject(
  root: Node,
  keys: JSONPath,
): { ancestor: Node; depth: number } {
  for (let depth = keys.length - 1; depth > 0; depth -= 1) {
    const ancestor = findNodeAtLocation(root, keys.slice(0, depth));
    if (ancestor) return { ancestor, depth };
  }
  return { ancestor: root, depth: 0 };
}

interface SetJsonValueParams {
  text: string;
  keys: JSONPath;
  value: unknown;
}

export function setJsonValue({
  text,
  keys,
  value,
}: SetJsonValueParams): string {
  const root = rootObject(text);
  const node = findNodeAtLocation(root, keys);
  const nearest = nearestObject(root, keys);
  const parent = node?.parent?.parent ?? nearest.ancestor;
  const [first] = parent.children ?? [];
  const inline =
    (node !== undefined &&
      ((node.parent?.parent !== undefined &&
        isInline(text, node.parent.parent)) ||
        (node.type === 'array' && isInline(text, node)))) ||
    (node === undefined &&
      first !== undefined &&
      !text.slice(parent.offset, first.offset).includes('\n'));
  const [edit] = modify(text, keys, value, {});
  if (!edit) return text;
  if (inline) {
    if (node) {
      return applyEdits(text, [
        {
          offset: node.offset,
          length: node.length,
          content: inlineJson(value),
        },
      ]);
    }
    const insertedKey = String(keys[nearest.depth]);
    const insertedValue = keys
      .slice(nearest.depth + 1)
      .reduceRight<unknown>((inner, key) => ({ [String(key)]: inner }), value);
    const prefix = edit.content.startsWith(',') ? ', ' : '';
    const suffix = edit.content.endsWith(',') ? ', ' : '';
    const content = `${prefix}${JSON.stringify(insertedKey)}: ${inlineJson(insertedValue)}${suffix}`;
    return applyEdits(text, [{ ...edit, content }]);
  }
  const next = applyEdits(text, [edit]);
  const emptyParent = (parent.children?.length ?? 0) === 0;
  const range = emptyParent
    ? {
        offset: parent.offset,
        length: parent.length + edit.content.length - edit.length,
      }
    : { offset: edit.offset, length: edit.content.length };
  return applyEdits(next, format(next, range, formattingOptions(text)));
}

interface JsonLocationParams {
  text: string;
  keys: JSONPath;
}

export function removeJsonProperty({ text, keys }: JsonLocationParams): string {
  const root = rootObject(text);
  const property = findNodeAtLocation(root, keys)?.parent;
  const container = property?.parent;
  const [edit] = modify(text, keys, undefined, {});
  if (!property || !container || !edit) return text;
  if ((container.children?.length ?? 0) === 1) {
    return applyEdits(text, [
      {
        ...edit,
        length: container.offset + container.length - 1 - edit.offset,
      },
    ]);
  }
  if (container.children?.[0] === property) {
    return applyEdits(text, [
      {
        ...edit,
        offset: property.offset,
        length: edit.offset + edit.length - property.offset,
      },
    ]);
  }
  return applyEdits(text, [edit]);
}

interface ArrayElementsParams extends JsonLocationParams {
  values: readonly string[];
}

export function appendArrayElements({
  text,
  keys,
  values,
}: ArrayElementsParams): string {
  const array = findNodeAtLocation(rootObject(text), keys);
  if (array?.type !== 'array') {
    throw new JsonMergeError('expected a list to append to');
  }
  if (values.length === 0) return text;
  const [first] = array.children ?? [];
  if (!first) {
    return applyEdits(text, [
      {
        offset: array.offset,
        length: array.length,
        content: inlineJson(values),
      },
    ]);
  }
  const [edit] = modify(text, [...keys, -1], values[0], {
    isArrayInsertion: true,
  });
  if (!edit) return text;
  const separator = text.slice(array.offset, first.offset).includes('\n')
    ? `,${lineEnding(text || null)}${lineIndent(text, first.offset)}`
    : ', ';
  const content = values
    .map((value) => `${separator}${JSON.stringify(value)}`)
    .join('');
  return applyEdits(text, [{ ...edit, content }]);
}

export function removeArrayElements({
  text,
  keys,
  values,
}: ArrayElementsParams): string {
  let result = text;
  for (const value of values) {
    for (;;) {
      const array = findNodeAtLocation(rootObject(result), keys);
      const children = array?.children ?? [];
      const index = children.findIndex(
        (item) => item.type === 'string' && item.value === value,
      );
      const child = children[index];
      if (!array || !child) break;
      const [edit] = modify(result, [...keys, index], undefined, {});
      if (!edit) break;
      const fixedEdit =
        children.length > 1 && index === children.length - 1
          ? { ...edit, length: child.offset + child.length - edit.offset }
          : edit;
      result = applyEdits(result, [fixedEdit]);
    }
  }
  return result;
}

export function rawJson({
  text,
  keys,
}: JsonLocationParams): string | undefined {
  const node = findNodeAtLocation(rootObject(text), keys);
  return node && text.slice(node.offset, node.offset + node.length);
}

interface ReplaceRawParams extends JsonLocationParams {
  raw: string;
}

export function replaceRawJson({ text, keys, raw }: ReplaceRawParams): string {
  const node = findNodeAtLocation(rootObject(text), keys);
  return node
    ? applyEdits(text, [
        { offset: node.offset, length: node.length, content: raw },
      ])
    : text;
}
