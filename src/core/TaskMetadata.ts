import type {
  CalendarSemanticType,
  NodeStatus,
  Priority,
  RoadmapNode,
} from '../types';

export interface CompactTaskFieldPresence {
  readonly startDate: boolean;
  readonly dueDate: boolean;
  readonly type: boolean;
  readonly priority: boolean;
  readonly status: boolean;
}

export interface CompactTaskMetadata {
  readonly dateLabel?: string;
  readonly typeLabel?: string;
  readonly priorityLabel?: string;
  readonly statusLabel?: string;
}

const CALENDAR_TYPE_LABELS: Readonly<Record<CalendarSemanticType, string>> = {
  exam: 'Exam',
  'assignment-deadline': 'Assignment deadline',
  'project-deadline': 'Project deadline',
  milestone: 'Milestone',
  presentation: 'Presentation',
  'regular-task': 'Task',
};

const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const STATUS_LABELS: Readonly<Record<NodeStatus, string>> = {
  todo: 'Todo',
  'in-progress': 'In progress',
  done: 'Done',
  unscheduled: 'Unscheduled',
};

export function calendarTypeDisplayLabel(value: CalendarSemanticType): string {
  return CALENDAR_TYPE_LABELS[value];
}

export function priorityDisplayLabel(value: Priority): string {
  return PRIORITY_LABELS[value];
}

export function statusDisplayLabel(value: NodeStatus): string {
  return STATUS_LABELS[value];
}

export function shouldUseCompactTaskPresentation(
  livePreview: boolean,
  node: Pick<RoadmapNode, 'source'>,
): boolean {
  return livePreview && node.source === 'inline';
}

export function formatCompactTaskDates(
  startDate: string | undefined,
  dueDate: string | undefined,
  locale: string | readonly string[] | undefined,
  now = new Date(),
): string | undefined {
  const start = parseDateOnly(startDate);
  const due = parseDateOnly(dueDate);
  if (start === null && due === null) return undefined;

  const currentYear = now.getFullYear();
  const includeYear =
    (start !== null && start.year !== currentYear) ||
    (due !== null && due.year !== currentYear) ||
    (start !== null && due !== null && start.year !== due.year);

  if (start !== null && due !== null) {
    const startLabel = formatDatePart(start, locale, includeYear);
    if (start.value === due.value) return startLabel;
    return `${startLabel} → ${formatDatePart(due, locale, includeYear)}`;
  }
  if (due !== null) return `Due ${formatDatePart(due, locale, includeYear)}`;
  return start === null ? undefined : `Starts ${formatDatePart(start, locale, includeYear)}`;
}

export function projectCompactTaskMetadata(
  node: RoadmapNode,
  fields: CompactTaskFieldPresence,
  locale: string | readonly string[] | undefined,
  now = new Date(),
): CompactTaskMetadata {
  const dateLabel = formatCompactTaskDates(
    fields.startDate ? node.startDate : undefined,
    fields.dueDate ? node.dueDate : undefined,
    locale,
    now,
  );

  return compactMetadata({
    dateLabel,
    typeLabel: fields.type ? calendarTypeDisplayLabel(node.calendarType) : undefined,
    priorityLabel:
      fields.priority && node.priority !== 'medium'
        ? priorityDisplayLabel(node.priority)
        : undefined,
    statusLabel:
      fields.status && node.status === 'in-progress'
        ? statusDisplayLabel(node.status)
        : undefined,
  });
}

function compactMetadata(value: CompactTaskMetadata): CompactTaskMetadata {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

interface ParsedDateOnly {
  readonly value: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseDateOnly(value: string | undefined): ParsedDateOnly | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? { value, year, month, day }
    : null;
}

function formatDatePart(
  date: ParsedDateOnly,
  locale: string | readonly string[] | undefined,
  includeYear: boolean,
): string {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
    ...(includeYear ? { year: 'numeric' as const } : {}),
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(value);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(value);
  }
}
