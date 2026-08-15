import type { NodeStatus, Priority } from '../types';

export interface GanttPriorityMarker {
  readonly symbol: string;
  readonly label: string;
  readonly tone: 'high' | 'low';
}

export interface GanttBarPresentation {
  readonly statusClass: `status-${NodeStatus}`;
  readonly priorityMarker: GanttPriorityMarker | null;
}

export function ganttPriorityMarker(priority: Priority | string): GanttPriorityMarker | null {
  const normalized = priority.trim().toLocaleLowerCase();
  if (normalized === 'highest') {
    return { symbol: '▲', label: 'Highest priority', tone: 'high' };
  }
  if (normalized === 'high') {
    return { symbol: '▲', label: 'High priority', tone: 'high' };
  }
  if (normalized === 'low') {
    return { symbol: '▼', label: 'Low priority', tone: 'low' };
  }
  return null;
}

export function ganttBarPresentation(
  status: NodeStatus,
  priority: Priority | string,
): GanttBarPresentation {
  return {
    statusClass: `status-${status}`,
    priorityMarker: ganttPriorityMarker(priority),
  };
}
