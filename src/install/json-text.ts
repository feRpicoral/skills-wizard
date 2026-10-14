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
import { lineEnding } from './lines.ts';

const DEFAULT_INDENT = '  ';

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

function nearestObject(root: Node, keys: JSONPath): Node {
  for (let depth = keys.length - 1; depth > 0; depth -= 1) {
    const ancestor = findNodeAtLocation(root, keys.slice(0, depth));
    if (ancestor) return ancestor;
  }
  return root;
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
  const parent = node?.parent?.parent ?? nearestObject(root, keys);
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
    const content = node
      ? inlineJson(value)
      : edit.content.replace(/^,/, ', ').replace(/":(?=\S)/g, '": ');
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

interface RemoveChildParams {
  text: string;
  container: Node;
  child: Node;
}

function removeChild({ text, container, child }: RemoveChildParams): string {
  const siblings = container.children ?? [];
  const index = siblings.indexOf(child);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const end = child.offset + child.length;
  if (previous) {
    const start = previous.offset + previous.length;
    return applyEdits(text, [
      { offset: start, length: end - start, content: '' },
    ]);
  }
  if (next) {
    return applyEdits(text, [
      {
        offset: child.offset,
        length: next.offset - child.offset,
        content: '',
      },
    ]);
  }
  return applyEdits(text, [
    {
      offset: container.offset + 1,
      length: container.length - 2,
      content: '',
    },
  ]);
}

interface JsonLocationParams {
  text: string;
  keys: JSONPath;
}

export function removeJsonProperty({ text, keys }: JsonLocationParams): string {
  const property = findNodeAtLocation(rootObject(text), keys)?.parent;
  const container = property?.parent;
  if (!property || !container) return text;
  return removeChild({ text, container, child: property });
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
  const items = values.map((value) => JSON.stringify(value));
  const [first] = array.children ?? [];
  const last = array.children?.at(-1);
  if (!first || !last) {
    return applyEdits(text, [
      {
        offset: array.offset + 1,
        length: array.length - 2,
        content: items.join(', '),
      },
    ]);
  }
  const separator = text.slice(array.offset, first.offset).includes('\n')
    ? `,${lineEnding(text || null)}${lineIndent(text, first.offset)}`
    : ', ';
  return applyEdits(text, [
    {
      offset: last.offset + last.length,
      length: 0,
      content: items.map((item) => `${separator}${item}`).join(''),
    },
  ]);
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
      const child = array?.children?.find(
        (item) => item.type === 'string' && item.value === value,
      );
      if (!array || !child) break;
      result = removeChild({ text: result, container: array, child });
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
  if (!node) return text;
  return applyEdits(text, [
    {
      offset: node.offset,
      length: node.length,
      content: raw,
    },
  ]);
}
