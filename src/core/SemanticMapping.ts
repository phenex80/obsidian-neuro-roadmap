import {
  CANONICAL_PROPERTY_FIELDS,
  CALENDAR_SEMANTIC_TYPES,
  NODE_STATUSES,
  NODE_TYPES,
  PRIORITIES,
  type CanonicalPropertyField,
  type CalendarSemanticType,
  type NodeStatus,
  type NodeType,
  type Priority,
  type PropertyMappings,
  type SemanticValueMappings,
} from '../types';

export type PropertyKeyMap = Readonly<Record<CanonicalPropertyField, readonly string[]>>;

export interface SemanticValueMap {
  readonly status: Readonly<Record<NodeStatus, readonly string[]>>;
  readonly priority: Readonly<Record<Priority, readonly string[]>>;
  readonly type: Readonly<Record<NodeType, readonly string[]>>;
  readonly calendarType: Readonly<Record<CalendarSemanticType, readonly string[]>>;
}

export function parseCommaSeparatedValues(value: string): string[] {
  return uniqueNonEmptyValues(value.split(','));
}

export function compilePropertyKeyMap(mappings: PropertyMappings): PropertyKeyMap {
  const compiled = {} as Record<CanonicalPropertyField, readonly string[]>;
  for (const field of CANONICAL_PROPERTY_FIELDS) {
    compiled[field] = parseCommaSeparatedValues(mappings[field]);
  }
  return compiled;
}

export function compileSemanticValueMap(mappings: SemanticValueMappings): SemanticValueMap {
  return {
    status: {
      todo: parseCommaSeparatedValues(mappings.statusTodo),
      'in-progress': parseCommaSeparatedValues(mappings.statusInProgress),
      done: parseCommaSeparatedValues(mappings.statusDone),
      unscheduled: parseCommaSeparatedValues(mappings.statusUnscheduled),
    },
    priority: {
      high: parseCommaSeparatedValues(mappings.priorityHigh),
      medium: parseCommaSeparatedValues(mappings.priorityMedium),
      low: parseCommaSeparatedValues(mappings.priorityLow),
    },
    type: {
      roadmap: parseCommaSeparatedValues(mappings.typeRoadmap),
      project: parseCommaSeparatedValues(mappings.typeProject),
      milestone: parseCommaSeparatedValues(mappings.typeMilestone),
      task: parseCommaSeparatedValues(mappings.typeTask),
    },
    calendarType: {
      exam: parseCommaSeparatedValues(mappings.calendarExam),
      'assignment-deadline': parseCommaSeparatedValues(mappings.calendarAssignmentDeadline),
      'project-deadline': parseCommaSeparatedValues(mappings.calendarProjectDeadline),
      milestone: parseCommaSeparatedValues(mappings.calendarMilestone),
      presentation: parseCommaSeparatedValues(mappings.calendarPresentation),
      'regular-task': parseCommaSeparatedValues(mappings.calendarRegularTask),
    },
  };
}

export function readMappedValue(
  values: Readonly<Record<string, unknown>>,
  acceptedKeys: readonly string[],
): { readonly key: string; readonly value: unknown } | undefined {
  const valuesByNormalizedKey = new Map(
    Object.entries(values).map(([key, value]) => [normalizePropertyKey(key), { key, value }]),
  );

  for (const acceptedKey of acceptedKeys) {
    const entry = valuesByNormalizedKey.get(normalizePropertyKey(acceptedKey));
    if (entry !== undefined) {
      return entry;
    }
  }
  return undefined;
}

export function mapSemanticEnum<const T extends string>(
  value: unknown,
  options: readonly T[],
  aliases: Readonly<Record<T, readonly string[]>>,
): T | undefined {
  const candidate = readValueStrings(value)[0];
  if (candidate === undefined) {
    return undefined;
  }

  const normalizedCandidate = normalizeSemanticValue(candidate);
  return options.find((option) =>
    [option, ...aliases[option]].some(
      (alias) => normalizeSemanticValue(alias) === normalizedCandidate,
    ),
  );
}

export function mapStatus(value: unknown, mapping: SemanticValueMap): NodeStatus | undefined {
  return mapSemanticEnum(value, NODE_STATUSES, mapping.status);
}

export function mapPriority(value: unknown, mapping: SemanticValueMap): Priority | undefined {
  return mapSemanticEnum(value, PRIORITIES, mapping.priority);
}

export function mapNodeType(value: unknown, mapping: SemanticValueMap): NodeType | undefined {
  return mapSemanticEnum(value, NODE_TYPES, mapping.type);
}

export function mapCalendarSemanticType(
  value: unknown,
  mapping: SemanticValueMap,
): CalendarSemanticType | undefined {
  return mapSemanticEnum(value, CALENDAR_SEMANTIC_TYPES, mapping.calendarType);
}

export function readValueStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry.trim();
      }
      if (typeof entry === 'number' || typeof entry === 'boolean') {
        return String(entry);
      }
      return '';
    })
    .filter((entry) => entry.length > 0);
}

export function normalizePropertyKey(value: string): string {
  return normalizeSemanticValue(value).replace(/-/gu, '');
}

export function normalizeSemanticValue(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_]+/gu, '-');
}

export function uniqueNonEmptyValues(values: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      unique.set(normalizePropertyKey(trimmed), trimmed);
    }
  }
  return Array.from(unique.values());
}
