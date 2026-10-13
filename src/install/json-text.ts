import detectIndent from 'detect-indent';
import {
  findNodeAtLocation,
  type JSONPath,
  type Node,
  parseTree,
} from 'jsonc-parser';

import { JsonMergeError } from '../errors.ts';
import { lineEnding } from './lines.ts';

const DEFAULT_INDENT = '  ';

interface Layout {
  eol: string;
  unit: string;
}

interface Splice {
  offset: number;
  length: number;
  content: string;
}

function splice(text: string, { offset, length, content }: Splice): string {
  return `${text.slice(0, offset)}${content}${text.slice(offset + length)}`;
}

function layoutOf(text: string): Layout {
  return {
    eol: lineEnding(text || null),
    unit: detectIndent(text).indent || DEFAULT_INDENT,
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

interface FormatParams {
  value: unknown;
  layout: Layout;
  indent: string;
  inline: boolean;
}

function formatValue({ value, layout, indent, inline }: FormatParams): string {
  if (inline) return inlineJson(value);
  return JSON.stringify(value, null, layout.unit)
    .split('\n')
    .join(`${layout.eol}${indent}`);
}

interface InsertPropertyParams {
  text: string;
  object: Node;
  name: string;
  value: unknown;
}

function insertProperty({
  text,
  object,
  name,
  value,
}: InsertPropertyParams): string {
  const layout = layoutOf(text);
  const key = JSON.stringify(name);
  const [first] = object.children ?? [];
  const last = object.children?.at(-1);
  if (!first || !last) {
    const indent = lineIndent(text, object.offset);
    const childIndent = `${indent}${layout.unit}`;
    const formatted = formatValue({
      value,
      layout,
      indent: childIndent,
      inline: false,
    });
    return splice(text, {
      offset: object.offset + 1,
      length: object.length - 2,
      content: `${layout.eol}${childIndent}${key}: ${formatted}${layout.eol}${indent}`,
    });
  }

  const offset = last.offset + last.length;
  if (!text.slice(object.offset, first.offset).includes('\n')) {
    return splice(text, {
      offset,
      length: 0,
      content: `, ${key}: ${inlineJson(value)}`,
    });
  }
  const indent = lineIndent(text, first.offset);
  const formatted = formatValue({ value, layout, indent, inline: false });
  return splice(text, {
    offset,
    length: 0,
    content: `,${layout.eol}${indent}${key}: ${formatted}`,
  });
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
  if (node) {
    const object = node.parent?.parent;
    const inline =
      (object !== undefined && isInline(text, object)) ||
      (node.type === 'array' && isInline(text, node));
    return splice(text, {
      offset: node.offset,
      length: node.length,
      content: formatValue({
        value,
        layout: layoutOf(text),
        indent: lineIndent(text, node.offset),
        inline,
      }),
    });
  }

  let depth = keys.length - 1;
  let object = root;
  for (; depth > 0; depth -= 1) {
    const ancestor = findNodeAtLocation(root, keys.slice(0, depth));
    if (ancestor) {
      object = ancestor;
      break;
    }
  }
  const nested = keys
    .slice(depth + 1)
    .reduceRight<unknown>((inner, key) => ({ [String(key)]: inner }), value);
  return insertProperty({
    text,
    object,
    name: String(keys[depth]),
    value: nested,
  });
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
    return splice(text, { offset: start, length: end - start, content: '' });
  }
  if (next) {
    return splice(text, {
      offset: child.offset,
      length: next.offset - child.offset,
      content: '',
    });
  }
  return splice(text, {
    offset: container.offset + 1,
    length: container.length - 2,
    content: '',
  });
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
    return splice(text, {
      offset: array.offset + 1,
      length: array.length - 2,
      content: items.join(', '),
    });
  }
  const separator = text.slice(array.offset, first.offset).includes('\n')
    ? `,${layoutOf(text).eol}${lineIndent(text, first.offset)}`
    : ', ';
  return splice(text, {
    offset: last.offset + last.length,
    length: 0,
    content: items.map((item) => `${separator}${item}`).join(''),
  });
}

export function removeArrayElements({
  text,
  keys,
  values,
}: ArrayElementsParams): string {
  let result = text;
  for (const value of values) {
    const array = findNodeAtLocation(rootObject(result), keys);
    const child = array?.children?.find(
      (item) => item.type === 'string' && item.value === value,
    );
    if (array && child)
      result = removeChild({ text: result, container: array, child });
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
  return splice(text, {
    offset: node.offset,
    length: node.length,
    content: raw,
  });
}
