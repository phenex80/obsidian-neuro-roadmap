import type {
  CalendarPolicy,
  CalendarReminderPolicy,
  CalendarSemanticType,
  RoadmapNode,
} from '../types';
import {
  addDays,
  formatEntityLabel,
  formatNodeTitle,
  isNodeOverdue,
  validDate,
} from './TimelineDomain';

export type CalendarItemOverride = 'include' | 'exclude';

export interface CalendarProjectionOptions {
  readonly automaticallyInclude: CalendarPolicy;
  readonly remindersEnabled: boolean;
  readonly reminderMinutes: CalendarReminderPolicy;
  readonly override?: CalendarItemOverride;
  readonly vaultName?: string;
  readonly today?: string;
}

export interface CalendarEventProjection {
  readonly internalItemId: string;
  readonly sourceNodeId: string;
  readonly semanticType: CalendarSemanticType;
  readonly title: string;
  readonly description: string;
  readonly startDate: string;
  readonly endDateExclusive: string;
  readonly allDay: true;
  readonly availability: 'free';
  readonly reminderMinutes: number | null;
  readonly completed: boolean;
  readonly overdue: boolean;
}

export function isCalendarEligible(
  node: RoadmapNode,
  options: CalendarProjectionOptions,
): boolean {
  if (calendarCommitmentDate(node) === null) {
    return false;
  }
  if (options.override === 'exclude') {
    return false;
  }
  if (options.override === 'include') {
    return true;
  }
  return options.automaticallyInclude[node.calendarType];
}

export function projectCalendarEvent(
  node: RoadmapNode,
  internalItemId: string,
  options: CalendarProjectionOptions,
): CalendarEventProjection | null {
  if (!isCalendarEligible(node, options)) {
    return null;
  }
  const eventDate = calendarCommitmentDate(node);
  if (eventDate === null) {
    return null;
  }
  const overdue = isNodeOverdue(node, options.today);
  return {
    internalItemId,
    sourceNodeId: node.id,
    semanticType: node.calendarType,
    title: calendarTitle(node),
    description: calendarDescription(node, options.vaultName, overdue),
    startDate: eventDate,
    endDateExclusive: addDays(eventDate, 1),
    allDay: true,
    availability: 'free',
    reminderMinutes: options.remindersEnabled
      ? options.reminderMinutes[node.calendarType]
      : null,
    completed: node.completed || node.status === 'done',
    overdue,
  };
}

export function calendarCommitmentDate(node: RoadmapNode): string | null {
  return validDate(node.dueDate) ?? validDate(node.startDate);
}

function calendarTitle(node: RoadmapNode): string {
  const title = formatNodeTitle(node);
  if (node.subject === undefined) {
    return title;
  }
  return `${formatEntityLabel(node.subject, node.subject)} · ${title}`;
}

function calendarDescription(
  node: RoadmapNode,
  vaultName: string | undefined,
  overdue: boolean,
): string {
  const sourceTarget = node.blockId === undefined ? node.path : `${node.path}#^${node.blockId}`;
  const source = vaultName === undefined
    ? node.path
    : `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(sourceTarget)}`;
  return [
    node.subject === undefined
      ? undefined
      : `Subject: ${formatEntityLabel(node.subject, node.subject)}`,
    node.project === undefined
      ? undefined
      : `Project: ${formatEntityLabel(node.project, node.project)}`,
    `Priority: ${node.priority}`,
    `Status: ${node.status}`,
    overdue ? 'Overdue: yes' : undefined,
    `Source: ${source}`,
    'Managed by Obsidian Neuro Roadmap',
  ].filter((line): line is string => line !== undefined).join('\n');
}
