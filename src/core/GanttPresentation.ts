import type { NodeStatus, Priority } from '../types';

export interface GanttPriorityMarker {
  readonly symbol: string;
  readonly label: string;
}

export interface GanttBarPresentation {
  readonly statusClass: `status-${NodeStatus}`;
  readonly priorityMarker: GanttPriorityMarker | null;
}

export function ganttPriorityMarker(priority: Priority | string): GanttPriorityMarker | null {
  const normalized = priority.trim().toLocaleLowerCase();
  if (normalized === 'highest') {
    return { symbol: '▲', label: 'Highest priority' };
  }
  if (normalized === 'high') {
    return { symbol: '▲', label: 'High priority' };
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
