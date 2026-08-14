import type { RoadmapNode } from '../types';
import {
  addDays,
  daysBetween,
  formatNodeTitle,
  isNodeDone,
  isNodeOverdue,
  todayDate,
  validDate,
} from './TimelineDomain';

export interface HorizonOptions {
  readonly nextDays: number;
  readonly criticalDays: number;
}

export interface HorizonPlan {
  readonly overdue: readonly RoadmapNode[];
  readonly now: readonly RoadmapNode[];
  readonly next: readonly RoadmapNode[];
  readonly later: readonly RoadmapNode[];
  readonly unscheduled: readonly RoadmapNode[];
}

export function classifyHorizon(
  nodes: readonly RoadmapNode[],
  options: HorizonOptions,
  today = todayDate(),
): HorizonPlan {
  const actionable = nodes.filter(isActionableTask).filter((node) => !isNodeDone(node));
  const overdue: RoadmapNode[] = [];
  const now: RoadmapNode[] = [];
  const next: RoadmapNode[] = [];
  const later: RoadmapNode[] = [];
  const unscheduled: RoadmapNode[] = [];
  const criticalEnd = addDays(today, Math.max(0, options.criticalDays));
  const nextEnd = addDays(today, Math.max(1, options.nextDays));

  for (const node of actionable) {
    const startDate = validDate(node.startDate);
    const dueDate = validDate(node.dueDate);
    const effectiveDate = dueDate ?? startDate;
    if (node.status === 'in-progress') {
      now.push(node);
      continue;
    }
    if (effectiveDate === null) {
      unscheduled.push(node);
      continue;
    }
    if (isNodeOverdue(node, today)) {
      overdue.push(node);
      continue;
    }
    if (
      dueDate === today ||
      (startDate !== null && startDate <= today) ||
      (dueDate !== null && dueDate > today && dueDate <= criticalEnd)
    ) {
      now.push(node);
      continue;
    }
    if (effectiveDate > today && effectiveDate <= nextEnd) {
      next.push(node);
      continue;
    }
    later.push(node);
  }

  return {
    overdue: overdue.sort(compareByUrgency),
    now: now.sort(compareNow),
    next: next.sort(compareByUrgency),
    later: later.sort(compareByUrgency),
    unscheduled: unscheduled.sort(compareUnscheduled),
  };
}

export function formatRelativeTaskDate(node: RoadmapNode, today = todayDate()): string {
  const dueDate = validDate(node.dueDate);
  const startDate = validDate(node.startDate);
  const date = dueDate ?? startDate;
  if (date === null) {
    return 'No schedule';
  }
  const difference = daysBetween(today, date);
  if (dueDate !== null && difference < 0 && !isNodeDone(node)) {
    const days = Math.abs(difference);
    return `${days} ${days === 1 ? 'day' : 'days'} overdue`;
  }
  if (difference === 0) {
    return dueDate !== null ? 'Due today' : 'Starts today';
  }
  if (difference === 1) {
    return dueDate !== null ? 'Due tomorrow' : 'Starts tomorrow';
  }
  if (difference > 1) {
    return `${dueDate !== null ? 'Due' : 'Starts'} in ${difference} days`;
  }
  const days = Math.abs(difference);
  return `Started ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function isActionableTask(node: RoadmapNode): boolean {
  return node.type === 'task' || node.source === 'inline';
}

function compareNow(left: RoadmapNode, right: RoadmapNode): number {
  const statusDifference = Number(right.status === 'in-progress') - Number(left.status === 'in-progress');
  return statusDifference || compareByUrgency(left, right);
}

function compareByUrgency(left: RoadmapNode, right: RoadmapNode): number {
  return (
    nodeDate(left).localeCompare(nodeDate(right)) ||
    priorityRank(left) - priorityRank(right) ||
    formatNodeTitle(left).localeCompare(formatNodeTitle(right)) ||
    left.id.localeCompare(right.id)
  );
}

function compareUnscheduled(left: RoadmapNode, right: RoadmapNode): number {
  return (
    priorityRank(left) - priorityRank(right) ||
    formatNodeTitle(left).localeCompare(formatNodeTitle(right)) ||
    left.id.localeCompare(right.id)
  );
}

function nodeDate(node: RoadmapNode): string {
  return validDate(node.dueDate) ?? validDate(node.startDate) ?? '9999-12-31';
}

function priorityRank(node: RoadmapNode): number {
  return node.priority === 'high' ? 0 : node.priority === 'medium' ? 1 : 2;
}
