import { calculateCalendarDaySpan } from './BufferCalculator';
import type { RoadmapIndexer } from './Indexer';
import type { RoadmapNode } from '../types';
import type { NodeDateUpdate } from '../utils/obsidianHelpers';

const MILLISECONDS_PER_DAY = 86_400_000;

/** Calculates non-destructive date shifts for downstream soft dependencies. */
export class DependencyEngine {
  constructor(private readonly indexer: RoadmapIndexer) {}

  calculateSoftDependencyUpdates(
    movedNode: RoadmapNode,
    nextStartDate: string,
  ): readonly NodeDateUpdate[] {
    if (movedNode.startDate === undefined) {
      return [];
    }

    const dayShift = daysBetween(movedNode.startDate, nextStartDate);
    if (dayShift === null || dayShift === 0) {
      return [];
    }

    const updates: NodeDateUpdate[] = [];
    const visited = new Set<string>([movedNode.id]);
    this.collectSoftDependents(movedNode.id, dayShift, visited, updates);
    return updates;
  }

  private collectSoftDependents(
    nodeId: string,
    dayShift: number,
    visited: Set<string>,
    updates: NodeDateUpdate[],
  ): void {
    for (const dependent of this.indexer.getDependents(nodeId)) {
      if (visited.has(dependent.id)) {
        continue;
      }
      visited.add(dependent.id);

      if (dependent.hardDependency || !hasValidDateRange(dependent)) {
        continue;
      }

      updates.push({
        node: dependent,
        startDate: addDays(dependent.startDate, dayShift),
        dueDate: addDays(dependent.dueDate, dayShift),
      });
      this.collectSoftDependents(dependent.id, dayShift, visited, updates);
    }
  }
}

function hasValidDateRange(node: RoadmapNode): node is RoadmapNode & { startDate: string; dueDate: string } {
  return (
    node.startDate !== undefined &&
    node.dueDate !== undefined &&
    calculateCalendarDaySpan(node.startDate, node.dueDate) !== null
  );
}

function daysBetween(startDate: string, endDate: string): number | null {
  const startTimestamp = toUtcTimestamp(startDate);
  const endTimestamp = toUtcTimestamp(endDate);
  return startTimestamp === null || endTimestamp === null
    ? null
    : (endTimestamp - startTimestamp) / MILLISECONDS_PER_DAY;
}

function addDays(date: string, days: number): string {
  const timestamp = toUtcTimestamp(date);
  if (timestamp === null) {
    return date;
  }

  return new Date(timestamp + days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

function toUtcTimestamp(date: string): number | null {
  const [yearValue, monthValue, dayValue] = date.split('-');
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const timestamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(timestamp) ? timestamp : null;
}
