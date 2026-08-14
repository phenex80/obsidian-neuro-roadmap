import type { RoadmapNode } from '../types';
import {
  buildTimelineOverview,
  createTimelineDomain,
  formatEntityLabel,
  formatNodeTitle,
  isNodeDone,
  isNodeOverdue,
  timelineDatePositionPercent,
  todayDate,
  validDate,
  type TimelineDomain,
  type TimelineOverviewItem,
} from './TimelineDomain';

export interface SubjectSummary {
  readonly subject: string;
  readonly taskNodes: readonly RoadmapNode[];
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly completionPercent: number;
  readonly overdueCount: number;
  readonly nextDeadline?: RoadmapNode;
  readonly domain: TimelineDomain;
  readonly overview: readonly TimelineOverviewItem[];
  readonly todayPosition: number | null;
}

export function buildSubjectSummaries(
  items: readonly RoadmapNode[],
  today = todayDate(),
): SubjectSummary[] {
  const groups = new Map<string, RoadmapNode[]>();
  for (const node of items) {
    const subject = node.subject ?? 'Nezaradené';
    const subjectNodes = groups.get(subject) ?? [];
    subjectNodes.push(node);
    groups.set(subject, subjectNodes);
  }

  return Array.from(groups.entries())
    .map(([subject, subjectNodes]) => createSubjectSummary(subject, subjectNodes, today))
    .filter((summary) => summary.totalTasks > 0)
    .sort((left, right) =>
      formatEntityLabel(left.subject, 'Nezaradené').localeCompare(
        formatEntityLabel(right.subject, 'Nezaradené'),
      ),
    );
}

function createSubjectSummary(
  subject: string,
  subjectNodes: readonly RoadmapNode[],
  today: string,
): SubjectSummary {
  const taskNodes = subjectNodes.filter(isTaskForCompletion);
  const completedTasks = taskNodes.filter(isNodeDone).length;
  const overdueCount = taskNodes.filter((node) => isNodeOverdue(node, today)).length;
  const nextDeadline = taskNodes
    .filter((node) => !isNodeDone(node) && validDate(node.dueDate) !== null)
    .filter((node) => (node.dueDate ?? '') >= today)
    .sort(
      (left, right) =>
        (left.dueDate ?? '').localeCompare(right.dueDate ?? '') ||
        formatNodeTitle(left).localeCompare(formatNodeTitle(right)),
    )[0];
  const timelineNodes = subjectNodes.filter(
    (node) => validDate(node.startDate) !== null || validDate(node.dueDate) !== null,
  );
  const domain = createTimelineDomain(timelineNodes, 1, today);

  return {
    subject,
    taskNodes,
    totalTasks: taskNodes.length,
    completedTasks,
    completionPercent:
      taskNodes.length === 0 ? 0 : Math.round((completedTasks / taskNodes.length) * 100),
    overdueCount,
    nextDeadline,
    domain,
    overview: buildTimelineOverview(timelineNodes, domain, 18, today),
    todayPosition: timelineDatePositionPercent(today, domain),
  };
}

function isTaskForCompletion(node: RoadmapNode): boolean {
  return node.type === 'task' || node.source === 'inline';
}
