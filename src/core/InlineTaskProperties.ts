import type { CanonicalPropertyField, NodeStatus } from '../types';
import type { PropertyKeyMap } from './SemanticMapping';
import { normalizePropertyKey } from './SemanticMapping';
import { replaceTaskCheckbox } from './MarkdownTask';

export type EditableTaskProperty = 'startDate' | 'dueDate' | 'type' | 'priority' | 'status';

export interface InlineTaskPropertyToken {
  readonly field: EditableTaskProperty;
  readonly key: string;
  readonly value: string;
  readonly from: number;
  readonly to: number;
}

export interface InlineTaskBlockIdToken {
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
}

const INLINE_PROPERTY_PATTERN =
  /\[([^\[\]:\r\n]+)::\s*(\[\[[^\]]+\]\]|[^\]]*?)\]/gu;
const MANAGED_BLOCK_ID_PATTERN = /\s+\^(nr-cal-[A-Za-z0-9-]+)\s*$/u;
const EDITABLE_FIELDS: readonly EditableTaskProperty[] = [
  'startDate',
  'dueDate',
  'type',
  'priority',
  'status',
];

export function findCompactTaskPropertyTokens(
  line: string,
  propertyKeys: PropertyKeyMap,
): readonly InlineTaskPropertyToken[] {
  const tokens: InlineTaskPropertyToken[] = [];
  for (const match of line.matchAll(INLINE_PROPERTY_PATTERN)) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key === undefined || value === undefined || match.index === undefined) continue;
    const field = editableFieldForKey(key, propertyKeys);
    if (field === undefined) continue;
    const from = includeLeadingWhitespace(line, match.index);
    tokens.push({ field, key, value, from, to: match.index + match[0].length });
  }
  return tokens;
}

export function findManagedCalendarBlockId(
  line: string,
  expectedBlockId?: string,
): InlineTaskBlockIdToken | undefined {
  const match = MANAGED_BLOCK_ID_PATTERN.exec(line);
  const blockId = match?.[1];
  if (match === null || blockId === undefined || match.index === undefined) return undefined;
  if (expectedBlockId !== undefined && blockId !== expectedBlockId) return undefined;
  return { blockId, from: match.index, to: match.index + match[0].length };
}

export function replaceInlineTaskProperty(
  line: string,
  key: string,
  value: string | null,
): string {
  assertSafePropertyKey(key);
  if (value !== null && /[\]\r\n]/u.test(value)) {
    throw new Error('Inline task property values cannot contain a closing bracket or newline.');
  }

  const tokenPattern = new RegExp(
    `\\[${escapeRegExp(key)}::\\s*(?:\\[\\[[^\\]]+\\]\\]|[^\\]]*?)\\]`,
    'iu',
  );
  const match = tokenPattern.exec(line);
  if (match !== null && match.index !== undefined) {
    if (value !== null) {
      return `${line.slice(0, match.index)}[${key}:: ${value}]${line.slice(match.index + match[0].length)}`;
    }
    const from = includeLeadingWhitespace(line, match.index);
    return `${line.slice(0, from)}${line.slice(match.index + match[0].length)}`;
  }

  if (value === null) return line;
  const blockAnchor = /\s+\^[A-Za-z0-9-]+\s*$/u.exec(line);
  const insertionPoint = blockAnchor?.index ?? line.length;
  return `${line.slice(0, insertionPoint).trimEnd()} [${key}:: ${value}]${line.slice(insertionPoint)}`;
}

export function replaceInlineTaskStatus(
  line: string,
  key: string,
  value: string,
  status: NodeStatus,
): string {
  const withCheckbox = replaceTaskCheckbox(line, status === 'done');
  const hasStatusToken = new RegExp(
    `\\[${escapeRegExp(key)}::\\s*(?:\\[\\[[^\\]]+\\]\\]|[^\\]]*?)\\]`,
    'iu',
  ).test(withCheckbox);
  if ((status === 'todo' || status === 'done') && !hasStatusToken) {
    return withCheckbox;
  }
  return replaceInlineTaskProperty(withCheckbox, key, value);
}

function editableFieldForKey(
  key: string,
  propertyKeys: PropertyKeyMap,
): EditableTaskProperty | undefined {
  const normalized = normalizePropertyKey(key);
  for (const field of EDITABLE_FIELDS) {
    const canonicalFields: readonly CanonicalPropertyField[] =
      field === 'type' ? ['calendarType', 'type'] : [field];
    if (
      canonicalFields.some((canonical) =>
        propertyKeys[canonical].some((candidate) => normalizePropertyKey(candidate) === normalized),
      )
    ) {
      return field;
    }
  }
  return undefined;
}

function includeLeadingWhitespace(line: string, index: number): number {
  return index > 0 && /\s/u.test(line[index - 1] ?? '') ? index - 1 : index;
}

function assertSafePropertyKey(key: string): void {
  if (key.trim().length === 0 || /[\[\]:\r\n]/u.test(key)) {
    throw new Error('Invalid inline task property key.');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
