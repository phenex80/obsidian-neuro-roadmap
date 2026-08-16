import { GANTT_SCALES, type GanttScale, type NodeStatus, type RoadmapNode } from '../types';

export const MILLISECONDS_PER_DAY = 86_400_000;
export const TIMELINE_SCALES = GANTT_SCALES;
export type TimelineScale = GanttScale;

const TIMELINE_VISIBLE_DAY_COUNTS: Readonly<Record<Exclude<TimelineScale, 'fit'>, number>> = {
  weeks: 35,
  months: 70,
  semester: 140,
};

export interface TimelineDomain {
  readonly startDate: string;
  readonly endDate: string;
  readonly dayCount: number;
}

export interface TimelineVisualItem {
  readonly kind: 'marker' | 'segment';
  readonly node: RoadmapNode;
  readonly startDate: string;
  readonly endDate: string;
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly centerPercent: number;
}

export interface TimelineOverviewItem {
  readonly kind: 'marker' | 'segment' | 'cluster';
  readonly key: string;
  readonly nodes: readonly RoadmapNode[];
  readonly leftPercent: number;
  readonly widthPercent: number;
  readonly lane: number;
  readonly status: NodeStatus;
  readonly overdue: boolean;
}

export function createTimelineDomain(
  nodes: readonly RoadmapNode[],
  minimumDayCount: number,
  fallbackStart = todayDate(),
): TimelineDomain {
  const dated = nodes
    .flatMap((node) => [validDate(node.startDate), validDate(node.dueDate)])
    .filter((date): date is string => date !== null)
    .sort();
  const startDate = dated[0] ?? fallbackStart;
  const latestDate = dated.at(-1) ?? startDate;
  const naturalDayCount = Math.max(1, daysBetween(startDate, latestDate) + 1);
  const dayCount = Math.max(minimumDayCount, naturalDayCount);
  return {
    startDate,
    endDate: addDays(startDate, dayCount - 1),
    dayCount,
  };
}

export function createTimelineDataDomain(
  nodes: readonly RoadmapNode[],
  fallbackStart = todayDate(),
): TimelineDomain {
  return createTimelineDomain(nodes, 1, fallbackStart);
}

export function createGanttTimelineDomain(
  nodes: readonly RoadmapNode[],
  dataDomain: TimelineDomain,
  scale: TimelineScale,
  fallbackStart = todayDate(),
): TimelineDomain {
  if (scale === 'fit') return createFitTimelineDomain(nodes, 7, fallbackStart);
  const visibleDayCount = timelineVisibleDayCount(scale, dataDomain.dayCount);
  if (dataDomain.dayCount >= visibleDayCount) return dataDomain;
  return {
    startDate: dataDomain.startDate,
    endDate: addDays(dataDomain.startDate, visibleDayCount - 1),
    dayCount: visibleDayCount,
  };
}

export function createFitTimelineDomain(
  nodes: readonly RoadmapNode[],
  paddingDays = 7,
  fallbackStart = todayDate(),
): TimelineDomain {
  const dated = nodes
    .flatMap((node) => [validDate(node.startDate), validDate(node.dueDate)])
    .filter((date): date is string => date !== null)
    .sort();
  const safePadding = Math.max(0, Math.floor(paddingDays));
  if (dated.length === 0) {
    const startDate = addDays(fallbackStart, -14);
    return {
      startDate,
      endDate: addDays(startDate, 27),
      dayCount: 28,
    };
  }
  const startDate = addDays(dated[0] ?? fallbackStart, -safePadding);
  const endDate = addDays(dated.at(-1) ?? fallbackStart, safePadding);
  return {
    startDate,
    endDate,
    dayCount: daysBetween(startDate, endDate) + 1,
  };
}

export function timelineVisibleDayCount(scale: TimelineScale, dataDayCount: number): number {
  return scale === 'fit'
    ? Math.max(1, dataDayCount)
    : TIMELINE_VISIBLE_DAY_COUNTS[scale];
}

export function timelineDayPixelWidth(
  scale: TimelineScale,
  viewportWidth: number,
  dataDayCount: number,
): number {
  const safeViewportWidth = Math.max(1, viewportWidth);
  return safeViewportWidth / timelineVisibleDayCount(scale, dataDayCount);
}

export function timelineContentPixelWidth(
  scale: TimelineScale,
  viewportWidth: number,
  dataDayCount: number,
): number {
  return timelineDayPixelWidth(scale, viewportWidth, dataDayCount) * Math.max(1, dataDayCount);
}

export function timelineScrollOffsetForDate(
  date: string,
  domain: TimelineDomain,
  scale: TimelineScale,
  viewportWidth: number,
): number | null {
  const valid = validDate(date);
  if (valid === null || valid < domain.startDate || valid > domain.endDate) return null;
  const dayWidth = timelineDayPixelWidth(scale, viewportWidth, domain.dayCount);
  const contentWidth = timelineContentPixelWidth(scale, viewportWidth, domain.dayCount);
  const dateCenter = (daysBetween(domain.startDate, valid) + 0.5) * dayWidth;
  return clamp(dateCenter - viewportWidth / 2, 0, Math.max(0, contentWidth - viewportWidth));
}

export function selectTimelineZoomAnchor(
  today: string,
  visibleStart: string | null,
  visibleEnd: string | null,
  viewportCenter: string | null,
  earliestRelevantDate: string,
): string {
  if (
    validDate(today) !== null &&
    visibleStart !== null &&
    visibleEnd !== null &&
    today >= visibleStart &&
    today <= visibleEnd
  ) {
    return today;
  }
  return validDate(viewportCenter ?? undefined) ?? earliestRelevantDate;
}

export function timelineOverviewBucketCount(scale: TimelineScale): number {
  if (scale === 'weeks') return 32;
  if (scale === 'months') return 24;
  if (scale === 'semester') return 18;
  return 16;
}

export function collapsedTimelineBucketCount(scale: TimelineScale): number {
  if (scale === 'weeks') return 20;
  if (scale === 'months') return 16;
  if (scale === 'semester') return 12;
  return 10;
}

export function createTimelineVisualItem(
  node: RoadmapNode,
  domain: TimelineDomain,
): TimelineVisualItem | null {
  const startDate = validDate(node.startDate) ?? validDate(node.dueDate);
  const endDate = validDate(node.dueDate) ?? validDate(node.startDate);
  if (startDate === null || endDate === null) {
    return null;
  }
  const safeStart = startDate <= endDate ? startDate : endDate;
  const safeEnd = startDate <= endDate ? endDate : startDate;
  const startIndex = clamp(daysBetween(domain.startDate, safeStart), 0, domain.dayCount - 1);
  const endIndex = clamp(daysBetween(domain.startDate, safeEnd), 0, domain.dayCount - 1);
  const marker = node.type === 'milestone' || node.startDate === undefined || node.dueDate === undefined;
  const leftPercent = (startIndex / domain.dayCount) * 100;
  const widthPercent = marker
    ? 0
    : (Math.max(1, endIndex - startIndex + 1) / domain.dayCount) * 100;
  return {
    kind: marker ? 'marker' : 'segment',
    node,
    startDate: safeStart,
    endDate: safeEnd,
    leftPercent,
    widthPercent,
    centerPercent: marker
      ? ((startIndex + 0.5) / domain.dayCount) * 100
      : ((startIndex + endIndex + 1) / 2 / domain.dayCount) * 100,
  };
}

/**
 * Deterministically bounds overview density to one aggregate per bucket.
 * The result remains stable for the same domain and node ordering at 5, 50, or 200+ tasks.
 */
export function buildTimelineOverview(
  nodes: readonly RoadmapNode[],
  domain: TimelineDomain,
  bucketCount: number,
  today = todayDate(),
): TimelineOverviewItem[] {
  const effectiveBucketCount = Math.max(1, Math.min(bucketCount, domain.dayCount));
  const buckets = new Map<number, TimelineVisualItem[]>();
  const visuals = nodes
    .map((node) => createTimelineVisualItem(node, domain))
    .filter((item): item is TimelineVisualItem => item !== null)
    .sort(
      (left, right) =>
        left.centerPercent - right.centerPercent || left.node.id.localeCompare(right.node.id),
    );

  for (const item of visuals) {
    const bucket = Math.min(
      effectiveBucketCount - 1,
      Math.floor((item.centerPercent / 100) * effectiveBucketCount),
    );
    const items = buckets.get(bucket) ?? [];
    items.push(item);
    buckets.set(bucket, items);
  }

  return Array.from(buckets.entries()).map(([bucket, items]) => {
    const nodesInBucket = items.map((item) => item.node);
    const onlyItem = items.length === 1 ? items[0] : undefined;
    const kind = onlyItem?.kind ?? 'cluster';
    return {
      kind,
      key:
        onlyItem === undefined
          ? `cluster-${bucket}-${nodesInBucket.map((node) => node.id).join('|')}`
          : onlyItem.node.id,
      nodes: nodesInBucket,
      leftPercent:
        onlyItem === undefined
          ? ((bucket + 0.5) / effectiveBucketCount) * 100
          : onlyItem.kind === 'marker'
            ? onlyItem.centerPercent
            : onlyItem.leftPercent,
      widthPercent:
        onlyItem?.kind === 'segment' ? Math.max(onlyItem.widthPercent, 0.35) : 0,
      lane: bucket % 3,
      status: aggregateStatus(nodesInBucket),
      overdue: nodesInBucket.some((node) => isNodeOverdue(node, today)),
    };
  });
}

export function validDate(value: string | undefined): string | null {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }
  const timestamp = toUtcTimestamp(value);
  return timestamp === null || new Date(timestamp).toISOString().slice(0, 10) !== value
    ? null
    : value;
}

export function timelineDatePositionPercent(
  date: string,
  domain: TimelineDomain,
  centerOnDay = true,
): number | null {
  const valid = validDate(date);
  if (valid === null || valid < domain.startDate || valid > domain.endDate) {
    return null;
  }
  const dayIndex = daysBetween(domain.startDate, valid);
  return ((dayIndex + (centerOnDay ? 0.5 : 0)) / domain.dayCount) * 100;
}

export function isNodeDone(node: RoadmapNode): boolean {
  return node.completed || node.status === 'done';
}

export function isNodeOverdue(node: RoadmapNode, today = todayDate()): boolean {
  const dueDate = validDate(node.dueDate);
  return dueDate !== null && dueDate < today && !isNodeDone(node);
}

export function daysBetween(startDate: string, endDate: string): number {
  const startTimestamp = toUtcTimestamp(startDate);
  const endTimestamp = toUtcTimestamp(endDate);
  return startTimestamp === null || endTimestamp === null
    ? 0
    : Math.round((endTimestamp - startTimestamp) / MILLISECONDS_PER_DAY);
}

export function addDays(date: string, days: number): string {
  const timestamp = toUtcTimestamp(date);
  return timestamp === null
    ? date
    : new Date(timestamp + days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

export function todayDate(now = new Date()): string {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    .toISOString()
    .slice(0, 10);
}

export function formatNodeTitle(node: RoadmapNode): string {
  if (node.title.trim().length > 0) {
    return node.title;
  }
  const filename = node.path.split('/').at(-1) ?? '';
  const basename = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  return basename.length > 0 ? basename : 'Unknown task';
}

export function formatEntityLabel(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const filename = value.split('/').at(-1) ?? value;
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
}

function aggregateStatus(nodes: readonly RoadmapNode[]): NodeStatus {
  if (nodes.some((node) => node.status === 'in-progress')) {
    return 'in-progress';
  }
  if (nodes.some((node) => !isNodeDone(node))) {
    return 'todo';
  }
  return 'done';
}

function toUtcTimestamp(date: string): number | null {
  const [yearValue, monthValue, dayValue] = date.split('-');
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
