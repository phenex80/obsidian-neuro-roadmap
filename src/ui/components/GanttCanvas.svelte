<script lang="ts">
  import { tick } from 'svelte';
  import { calculateBufferedDuration, calculateCalendarDaySpan } from '../../core/BufferCalculator';
  import {
    addDays,
    buildTimelineOverview,
    createTimelineDomain,
    daysBetween,
    formatEntityLabel,
    formatNodeTitle,
    isNodeOverdue,
    todayDate,
    validDate,
    type TimelineOverviewItem,
  } from '../../core/TimelineDomain';
  import type { CalendarItemOverride, RoadmapNode } from '../../types';

  let {
    nodes,
    scale,
    enableColorCoding,
    onReschedule,
    onSchedule,
    onCreate,
    onEdit,
    onToggleComplete,
    onOpenSource,
    getCalendarOverride,
    isCalendarIncluded,
    isCalendarAvailable,
    onToggleCalendar,
  }: {
    nodes: readonly RoadmapNode[];
    scale: 'days' | 'weeks' | 'months';
    enableColorCoding: boolean;
    onReschedule: (node: RoadmapNode, startDate: string, dueDate: string) => Promise<void>;
    onSchedule: (node: RoadmapNode, startDate: string, dueDate: string) => Promise<void>;
    onCreate: (startDate: string, dueDate: string) => Promise<void>;
    onEdit: (node: RoadmapNode) => void;
    onToggleComplete: (node: RoadmapNode, completed: boolean) => Promise<void>;
    onOpenSource: (node: RoadmapNode) => Promise<void>;
    getCalendarOverride: (node: RoadmapNode) => CalendarItemOverride | undefined;
    isCalendarIncluded: (node: RoadmapNode) => boolean;
    isCalendarAvailable: (node: RoadmapNode) => boolean;
    onToggleCalendar: (node: RoadmapNode) => Promise<void>;
  } = $props();

  const EMPTY_ROW_COUNT = 3;
  const UNASSIGNED_SUBJECT = 'Nezaradené';
  const UNASSIGNED_PROJECT = '__unassigned-project__';

  interface HeaderSegment {
    key: string;
    label: string;
    startColumn: number;
    span: number;
  }

  interface GanttRow {
    kind: 'subject' | 'project' | 'task';
    key: string;
    label: string;
    row: number;
    nodes: readonly RoadmapNode[];
    node?: RoadmapNode;
    subject: string;
    project?: string;
    collapsed: boolean;
    subjectEnd: boolean;
  }

  interface TimelineNodeItem {
    readonly node: RoadmapNode;
    readonly row: number;
    readonly startColumn: number;
    readonly spanColumns: number;
    readonly marker: boolean;
  }

  let collapsedSubjects = $state<string[]>([]);
  let collapsedProjects = $state<string[]>([]);
  let selectedNodeId = $state<string | null>(null);
  let datedNodes = $derived(
    nodes
      .filter(hasUsableDate)
      .sort(compareDatedNodes),
  );
  let hierarchyNodes = $derived([...nodes].sort(compareDatedNodes));
  let minimumDayCount = $derived(scale === 'days' ? 14 : scale === 'weeks' ? 84 : 365);
  let domainNodes = $derived(datedNodes.map(expandNodeForBufferedDomain));
  let timelineDomain = $derived(createTimelineDomain(domainNodes, minimumDayCount));
  let timelineStart = $derived(timelineDomain.startDate);
  let dayCount = $derived(timelineDomain.dayCount);
  let dayLabels = $derived(
    Array.from({ length: dayCount }, (_, index) => addDays(timelineStart, index)),
  );
  let headerSegments = $derived(buildHeaderSegments(dayLabels, scale));
  let ganttRows = $derived(buildHierarchyRows(hierarchyNodes, collapsedSubjects, collapsedProjects));
  let rowCount = $derived(Math.max(ganttRows.length, EMPTY_ROW_COUNT));
  let rowNumbers = $derived(Array.from({ length: rowCount }, (_, index) => index + 1));
  let timelineNodes = $derived(buildTimelineNodes(ganttRows, timelineStart));
  let todayIndex = $derived(daysBetween(timelineStart, todayDate()));
  let todayColumn = $derived(todayIndex + 1);
  let isTodayVisible = $derived(todayIndex >= 0 && todayIndex < dayCount);
  let overviewItems = $derived(
    buildTimelineOverview(datedNodes, timelineDomain, overviewBucketCount(scale)),
  );

  let timelineBody = $state<HTMLDivElement>();
  let draggedNode = $state<RoadmapNode | null>(null);
  let dragStartX = $state<number | null>(null);
  let creationStartDate = $state<string | null>(null);
  let creationStartX = $state<number | null>(null);
  let writing = $state(false);

  function hasUsableDate(node: RoadmapNode): boolean {
    return validDate(node.startDate) !== null || validDate(node.dueDate) !== null;
  }

  function hasDateRange(node: RoadmapNode): node is RoadmapNode & { startDate: string; dueDate: string } {
    return (
      node.startDate !== undefined &&
      node.dueDate !== undefined &&
      validDate(node.startDate) !== null &&
      validDate(node.dueDate) !== null &&
      calculateCalendarDaySpan(node.startDate, node.dueDate) !== null
    );
  }

  function compareDatedNodes(left: RoadmapNode, right: RoadmapNode): number {
    const leftDate = validDate(left.startDate) ?? validDate(left.dueDate) ?? '';
    const rightDate = validDate(right.startDate) ?? validDate(right.dueDate) ?? '';
    return leftDate.localeCompare(rightDate) || formatNodeTitle(left).localeCompare(formatNodeTitle(right));
  }

  function expandNodeForBufferedDomain(node: RoadmapNode): RoadmapNode {
    if (!hasDateRange(node)) {
      return node;
    }
    const duration = calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer);
    return duration === null
      ? node
      : { ...node, dueDate: addDays(node.startDate, Math.max(1, Math.ceil(duration)) - 1) };
  }

  function buildHierarchyRows(
    items: readonly RoadmapNode[],
    hiddenSubjects: readonly string[],
    hiddenProjects: readonly string[],
  ): GanttRow[] {
    const subjects = new Map<string, RoadmapNode[]>();
    for (const node of items) {
      const subject = node.subject ?? UNASSIGNED_SUBJECT;
      const subjectNodes = subjects.get(subject) ?? [];
      subjectNodes.push(node);
      subjects.set(subject, subjectNodes);
    }

    const rows: GanttRow[] = [];
    const sortedSubjects = Array.from(subjects.entries()).sort(([left], [right]) =>
      formatEntityLabel(left, UNASSIGNED_SUBJECT).localeCompare(
        formatEntityLabel(right, UNASSIGNED_SUBJECT),
      ),
    );

    for (const [subject, subjectNodes] of sortedSubjects) {
      const subjectCollapsed = hiddenSubjects.includes(subject);
      rows.push({
        kind: 'subject',
        key: `subject:${subject}`,
        label: formatEntityLabel(subject, UNASSIGNED_SUBJECT),
        row: rows.length + 1,
        nodes: subjectNodes,
        subject,
        collapsed: subjectCollapsed,
        subjectEnd: subjectCollapsed,
      });
      if (subjectCollapsed) {
        continue;
      }

      const projects = new Map<string, RoadmapNode[]>();
      for (const node of subjectNodes) {
        const project = node.project ?? UNASSIGNED_PROJECT;
        const projectNodes = projects.get(project) ?? [];
        projectNodes.push(node);
        projects.set(project, projectNodes);
      }
      const sortedProjects = Array.from(projects.entries()).sort(([left], [right]) => {
        if (left === UNASSIGNED_PROJECT) return -1;
        if (right === UNASSIGNED_PROJECT) return 1;
        return formatEntityLabel(left, left).localeCompare(formatEntityLabel(right, right));
      });

      for (const [project, projectNodes] of sortedProjects) {
        if (project !== UNASSIGNED_PROJECT) {
          const projectKey = `${subject}\u0000${project}`;
          const projectCollapsed = hiddenProjects.includes(projectKey);
          rows.push({
            kind: 'project',
            key: `project:${projectKey}`,
            label: formatEntityLabel(project, project),
            row: rows.length + 1,
            nodes: projectNodes,
            subject,
            project,
            collapsed: projectCollapsed,
            subjectEnd: false,
          });
          if (projectCollapsed) {
            continue;
          }
        }

        for (const node of projectNodes.filter(hasUsableDate)) {
          rows.push({
            kind: 'task',
            key: `task:${node.id}`,
            label: formatNodeTitle(node),
            row: rows.length + 1,
            nodes: [node],
            node,
            subject,
            project: project === UNASSIGNED_PROJECT ? undefined : project,
            collapsed: false,
            subjectEnd: false,
          });
        }
      }
      const lastRow = rows.at(-1);
      if (lastRow !== undefined && lastRow.subject === subject) {
        lastRow.subjectEnd = true;
      }
    }
    return rows;
  }

  function buildTimelineNodes(rows: readonly GanttRow[], startDate: string): TimelineNodeItem[] {
    return rows.flatMap((row): TimelineNodeItem[] => {
      const node = row.node;
      if (row.kind !== 'task' || node === undefined) {
        return [];
      }
      const start = validDate(node.startDate) ?? validDate(node.dueDate);
      if (start === null) {
        return [];
      }
      const marker = node.type === 'milestone' || !hasDateRange(node);
      const duration = hasDateRange(node)
        ? calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer)
        : 1;
      return [{
        node,
        row: row.row,
        startColumn: daysBetween(startDate, start) + 1,
        spanColumns: marker ? 1 : Math.max(1, Math.ceil(duration ?? 1)),
        marker,
      }];
    });
  }

  function toggleSubject(subject: string): void {
    collapsedSubjects = collapsedSubjects.includes(subject)
      ? collapsedSubjects.filter((value) => value !== subject)
      : [...collapsedSubjects, subject];
  }

  function toggleProject(subject: string, project: string): void {
    const key = `${subject}\u0000${project}`;
    collapsedProjects = collapsedProjects.includes(key)
      ? collapsedProjects.filter((value) => value !== key)
      : [...collapsedProjects, key];
  }

  function buildHeaderSegments(
    dates: readonly string[],
    timelineScale: 'days' | 'weeks' | 'months',
  ): HeaderSegment[] {
    if (timelineScale === 'days') {
      return dates.map((date, index) => ({
        key: date,
        label: formatDay(date),
        startColumn: index + 1,
        span: 1,
      }));
    }

    const segments: HeaderSegment[] = [];
    for (const [index, date] of dates.entries()) {
      const label = timelineScale === 'weeks' ? formatWeek(date) : formatMonth(date);
      const key = timelineScale === 'weeks' ? formatWeekKey(date) : `${timelineScale}-${label}`;
      const previous = segments.at(-1);
      if (previous?.key === key) {
        previous.span += 1;
      } else {
        segments.push({ key, label, startColumn: index + 1, span: 1 });
      }
    }
    return segments;
  }

  function formatDay(date: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  }

  function formatWeek(date: string): string {
    return formatWeekKey(date).split('-').at(-1) ?? formatWeekKey(date);
  }

  function formatWeekKey(date: string): string {
    const current = new Date(`${date}T00:00:00Z`);
    const day = current.getUTCDay() || 7;
    current.setUTCDate(current.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
    const week = Math.ceil((daysBetween(yearStart.toISOString().slice(0, 10), current.toISOString().slice(0, 10)) + 1) / 7);
    return `${current.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function formatMonth(date: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  }

  function getDayWidth(timelineScale: 'days' | 'weeks' | 'months'): string {
    if (timelineScale === 'weeks') return '15px';
    if (timelineScale === 'months') return '4px';
    return 'clamp(4.5rem, 7vw, 6rem)';
  }

  function overviewBucketCount(timelineScale: 'days' | 'weeks' | 'months'): number {
    return timelineScale === 'days' ? 48 : timelineScale === 'weeks' ? 32 : 18;
  }

  function collapsedBucketCount(timelineScale: 'days' | 'weeks' | 'months'): number {
    return timelineScale === 'days' ? 36 : timelineScale === 'weeks' ? 20 : 12;
  }

  function collapsedOverviewItems(row: GanttRow): TimelineOverviewItem[] {
    return row.collapsed
      ? buildTimelineOverview(row.nodes, timelineDomain, collapsedBucketCount(scale))
      : [];
  }

  function isMilestoneItem(item: TimelineOverviewItem): boolean {
    return item.kind === 'marker' && item.nodes[0]?.type === 'milestone';
  }

  function unscheduledCount(row: GanttRow): number {
    return row.nodes.filter((node) => !hasUsableDate(node)).length;
  }

  function groupCountLabel(row: GanttRow): string {
    const unscheduled = unscheduledCount(row);
    return unscheduled === 0
      ? `${row.nodes.length} items`
      : `${row.nodes.length} items · ${unscheduled} unscheduled`;
  }

  function groupTooltip(row: GanttRow): string {
    return `${row.label}\n${groupCountLabel(row)}`;
  }

  function isWeekend(date: string): boolean {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }

  function dateFromPointer(event: PointerEvent | DragEvent): string | null {
    if (timelineBody === undefined) {
      return null;
    }
    const bounds = timelineBody.getBoundingClientRect();
    if (bounds.width === 0) {
      return null;
    }
    const dayWidth = bounds.width / dayCount;
    const dayIndex = Math.min(
      dayCount - 1,
      Math.max(0, Math.floor((event.clientX - bounds.left) / dayWidth)),
    );
    return addDays(timelineStart, dayIndex);
  }

  function onNodePointerDown(event: PointerEvent, node: RoadmapNode): void {
    if (event.button !== 0 || writing || isTaskAction(event.target)) {
      return;
    }
    event.stopPropagation();
    draggedNode = node;
    dragStartX = event.clientX;
    timelineBody?.setPointerCapture(event.pointerId);
  }

  function onTimelinePointerDown(event: PointerEvent): void {
    if (writing || isTimelineItem(event.target) || isHierarchyBand(event.target)) {
      return;
    }
    creationStartDate = dateFromPointer(event);
    creationStartX = event.clientX;
    timelineBody?.setPointerCapture(event.pointerId);
  }

  function onTimelinePointerUp(event: PointerEvent): void {
    if (draggedNode !== null) {
      const minimumGesture = dayPixelWidth() / 4;
      if (dragStartX !== null && Math.abs(event.clientX - dragStartX) >= minimumGesture) {
        void persistReschedule(draggedNode, event);
      } else {
        selectedNodeId = draggedNode.id;
      }
      clearPointerState();
      return;
    }

    if (creationStartDate !== null && creationStartX !== null) {
      const endDate = dateFromPointer(event);
      if (endDate !== null && Math.abs(event.clientX - creationStartX) >= dayPixelWidth() / 4) {
        const startDate = creationStartDate <= endDate ? creationStartDate : endDate;
        const dueDate = creationStartDate <= endDate ? endDate : creationStartDate;
        void persistCreate(startDate, dueDate);
      }
    }
    clearPointerState();
  }

  function dayPixelWidth(): number {
    return timelineBody === undefined ? 0 : timelineBody.getBoundingClientRect().width / dayCount;
  }

  function onTimelineDrop(event: DragEvent): void {
    event.preventDefault();
    const nodeId = event.dataTransfer?.getData('application/x-neuro-roadmap-node');
    const startDate = dateFromPointer(event);
    const node = nodeId === undefined ? undefined : nodes.find((candidate) => candidate.id === nodeId);
    if (node !== undefined && startDate !== null) {
      void persistSchedule(node, startDate, startDate);
    }
  }

  function onTimelineKeyDown(event: KeyboardEvent, node: RoadmapNode): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void onOpenSource(node);
    }
  }

  async function persistReschedule(node: RoadmapNode, event: PointerEvent): Promise<void> {
    const startDate = dateFromPointer(event);
    if (startDate === null) {
      return;
    }
    const span = hasDateRange(node)
      ? calculateCalendarDaySpan(node.startDate, node.dueDate)
      : 1;
    if (span === null) {
      return;
    }
    writing = true;
    try {
      await onReschedule(node, startDate, addDays(startDate, span - 1));
    } finally {
      writing = false;
    }
  }

  async function persistSchedule(node: RoadmapNode, startDate: string, dueDate: string): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      await onSchedule(node, startDate, dueDate);
    } finally {
      writing = false;
    }
  }

  async function persistCreate(startDate: string, dueDate: string): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      await onCreate(startDate, dueDate);
    } finally {
      writing = false;
    }
  }

  async function toggleCompletion(node: RoadmapNode): Promise<void> {
    if (writing || node.source !== 'inline') return;
    writing = true;
    try {
      await onToggleComplete(node, !node.completed);
    } finally {
      writing = false;
    }
  }

  async function focusOverviewItem(item: TimelineOverviewItem): Promise<void> {
    const node = item.nodes[0];
    if (node === undefined) return;
    const subject = node.subject ?? UNASSIGNED_SUBJECT;
    if (collapsedSubjects.includes(subject)) {
      collapsedSubjects = collapsedSubjects.filter((value) => value !== subject);
    }
    if (node.project !== undefined) {
      const projectKey = `${subject}\u0000${node.project}`;
      collapsedProjects = collapsedProjects.filter((value) => value !== projectKey);
    }
    selectedNodeId = node.id;
    await tick();
    const selector = `[data-node-key="${encodeURIComponent(node.id)}"]`;
    timelineBody?.querySelector<HTMLElement>(selector)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'center',
    });
  }

  function overviewTooltip(item: TimelineOverviewItem): string {
    if (item.kind === 'cluster') {
      const titles = item.nodes.slice(0, 4).map(formatNodeTitle);
      const remaining = item.nodes.length - titles.length;
      return [`${item.nodes.length} items`, ...titles, remaining > 0 ? `+${remaining} more` : '']
        .filter((line) => line.length > 0)
        .join('\n');
    }
    const node = item.nodes[0];
    return node === undefined ? '' : nodeTooltip(node);
  }

  function nodeTooltip(node: RoadmapNode): string {
    const dates = node.startDate !== undefined && node.dueDate !== undefined
      ? `${node.startDate} → ${node.dueDate}`
      : node.dueDate ?? node.startDate ?? 'No date';
    return [
      formatNodeTitle(node),
      `Subject: ${formatEntityLabel(node.subject, UNASSIGNED_SUBJECT)}`,
      node.project === undefined ? '' : `Project: ${formatEntityLabel(node.project, node.project)}`,
      `Status: ${node.status}`,
      dates,
      isNodeOverdue(node) ? 'Overdue' : '',
      node.hardDependency ? 'Fixed date' : '',
    ].filter((line) => line.length > 0).join('\n');
  }

  function calendarActionLabel(node: RoadmapNode): string {
    if (!isCalendarAvailable(node)) return 'Add a date before using Calendar';
    const override = getCalendarOverride(node);
    if (override === 'include') return 'Included by override · Use automatic calendar policy';
    if (override === 'exclude') return 'Excluded by override · Use automatic calendar policy';
    return isCalendarIncluded(node)
      ? 'Synced to calendar · Exclude from calendar'
      : 'Add to calendar';
  }

  function clearPointerState(): void {
    draggedNode = null;
    dragStartX = null;
    creationStartDate = null;
    creationStartX = null;
  }

  function isTimelineItem(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      target.closest('.timeline-pill, .timeline-marker, .collapsed-ribbon-item') !== null
    );
  }

  function isHierarchyBand(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.hierarchy-band') !== null;
  }

  function isTaskAction(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.task-action') !== null;
  }
</script>

<section class="gantt" aria-label="Gantt timeline">
  <div class="gantt-scroll">
    <div class="gantt-shell" style={`--gantt-day-width: ${getDayWidth(scale)}`}>
      <aside class="task-rail" aria-label="Scheduled task list">
        <div class="overview-rail">
          <strong>Overview</strong>
          <span>{datedNodes.length}</span>
        </div>
        <div class="rail-header">Subject · Project · Task</div>
        <div class="task-list" style={`--row-count: ${rowCount}`}>
          {#each ganttRows as row (row.key)}
            {#if row.kind === 'subject'}
              <button
                type="button"
                class="hierarchy-row subject-row"
                class:subject-end={row.subjectEnd}
                style={`grid-row: ${row.row}`}
                aria-expanded={!row.collapsed}
                title={groupTooltip(row)}
                onclick={() => toggleSubject(row.subject)}
              >
                <span class="disclosure">{row.collapsed ? '▸' : '▾'}</span>
                <strong>{row.label}</strong>
                <small>{groupCountLabel(row)}</small>
              </button>
            {:else if row.kind === 'project' && row.project !== undefined}
              <button
                type="button"
                class="hierarchy-row project-row"
                class:subject-end={row.subjectEnd}
                style={`grid-row: ${row.row}`}
                aria-expanded={!row.collapsed}
                title={groupTooltip(row)}
                onclick={() => toggleProject(row.subject, row.project ?? '')}
              >
                <span class="disclosure">{row.collapsed ? '▸' : '▾'}</span>
                <span>{row.label}</span>
                <small>{groupCountLabel(row)}</small>
              </button>
            {:else if row.node !== undefined}
              {@const taskNode = row.node}
              <div
                class="task-row"
                class:subject-end={row.subjectEnd}
                class:selected={selectedNodeId === taskNode.id}
                style={`grid-row: ${row.row}`}
                title={nodeTooltip(taskNode)}
              >
                {#if taskNode.source === 'inline'}
                  <button
                    type="button"
                    class="task-action checkbox-action"
                    aria-label={`${taskNode.completed ? 'Uncheck' : 'Complete'} ${formatNodeTitle(taskNode)}`}
                    aria-pressed={taskNode.completed}
                    onclick={() => void toggleCompletion(taskNode)}
                  >{taskNode.completed ? '☑' : '☐'}</button>
                {:else}
                  <span class="action-spacer" aria-hidden="true"></span>
                {/if}
                <button
                  type="button"
                  class="task-action source-action"
                  onclick={() => void onOpenSource(taskNode)}
                >
                  <span>{row.label}</span>
                </button>
                <button
                  type="button"
                  class="task-action scratchpad-action"
                  title={`Quick note for ${row.label}`}
                  aria-label={`Quick note for ${row.label}`}
                  onclick={() => onEdit(taskNode)}
                >✎</button>
                <button
                  type="button"
                  class="task-action calendar-action"
                  class:included={isCalendarIncluded(taskNode)}
                  class:excluded={getCalendarOverride(taskNode) === 'exclude'}
                  title={calendarActionLabel(taskNode)}
                  aria-label={`${calendarActionLabel(taskNode)}: ${formatNodeTitle(taskNode)}`}
                  aria-pressed={isCalendarIncluded(taskNode)}
                  disabled={!isCalendarAvailable(taskNode)}
                  onclick={() => void onToggleCalendar(taskNode)}
                >{getCalendarOverride(taskNode) === 'exclude' ? '⊘' : isCalendarIncluded(taskNode) ? '◉' : '○'}</button>
              </div>
            {/if}
          {/each}
        </div>
      </aside>

      <div
        class="timeline-panel"
        style={`--day-count: ${dayCount}; --row-count: ${rowCount}`}
      >
        <div class="overview-ribbon" aria-label="Roadmap overview timeline">
          {#each overviewItems as item (item.key)}
            <button
              type="button"
              class={`overview-item overview-${item.kind} status-${item.status}`}
              class:color-coded={enableColorCoding}
              class:overdue={item.overdue}
              style={`--overview-left: ${item.leftPercent}%; --overview-width: ${item.widthPercent}%; --overview-lane: ${item.lane}`}
              title={overviewTooltip(item)}
              aria-label={overviewTooltip(item)}
              onclick={() => void focusOverviewItem(item)}
            >
              {#if item.kind === 'cluster'}
                <span>+{item.nodes.length}</span>
              {/if}
            </button>
          {/each}
        </div>

        <div class={`day-header scale-${scale}`} aria-hidden="true">
          {#each headerSegments as segment (segment.key)}
            <span
              style={`grid-column: ${segment.startColumn} / span ${segment.span}`}
              title={segment.label}
            >{segment.label}</span>
          {/each}
        </div>

        <div
          class="timeline-grid"
          class:is-writing={writing}
          bind:this={timelineBody}
          role="application"
          aria-label="Drag tasks to reschedule, or drag on an empty row to create a task"
          onpointerdown={onTimelinePointerDown}
          onpointerup={onTimelinePointerUp}
          onpointercancel={clearPointerState}
          ondragover={(event) => event.preventDefault()}
          ondrop={onTimelineDrop}
        >
          {#each dayLabels as date, index (date)}
            <div
              class="day-track"
              class:weekend={isWeekend(date)}
              style={`grid-column: ${index + 1}; grid-row: 1 / -1`}
              title={date}
            ></div>
          {/each}

          {#each rowNumbers as row (row)}
            <div class="row-track" style={`grid-column: 1 / -1; grid-row: ${row}`}></div>
          {/each}

          {#each ganttRows.filter((row) => row.kind !== 'task') as row (row.key)}
            <div
              class={`hierarchy-band ${row.kind}-band`}
              class:subject-end={row.subjectEnd}
              style={`grid-column: 1 / -1; grid-row: ${row.row}`}
            ></div>
            {@const compactItems = collapsedOverviewItems(row)}
            {#if compactItems.length > 0}
              <div
                class={`collapsed-ribbon ${row.kind}-ribbon`}
                style={`grid-column: 1 / -1; grid-row: ${row.row}`}
                aria-label={`${row.label} compact timeline. ${groupCountLabel(row)}`}
              >
                {#each compactItems as item (item.key)}
                  <button
                    type="button"
                    class={`collapsed-ribbon-item compact-${item.kind} status-${item.status}`}
                    class:compact-milestone={isMilestoneItem(item)}
                    class:color-coded={enableColorCoding}
                    class:overdue={item.overdue}
                    style={`--compact-left: ${item.leftPercent}%; --compact-width: ${item.widthPercent}%; --compact-lane: ${item.lane}`}
                    title={overviewTooltip(item)}
                    aria-label={overviewTooltip(item)}
                    onclick={() => void focusOverviewItem(item)}
                  >
                    {#if item.kind === 'cluster'}
                      <span>+{item.nodes.length}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          {/each}

          {#each ganttRows.filter((row) => row.subjectEnd) as row (row.key)}
            <div class="subject-separator" style={`grid-column: 1 / -1; grid-row: ${row.row}`}></div>
          {/each}

          {#each timelineNodes as item (item.node.id)}
            <div
              role="button"
              tabindex="0"
              data-node-key={encodeURIComponent(item.node.id)}
              class:item-selected={selectedNodeId === item.node.id}
              class:timeline-marker={item.marker}
              class:milestone-marker={item.node.type === 'milestone'}
              class:timeline-pill={!item.marker}
              class:color-coded={enableColorCoding}
              class:overdue={isNodeOverdue(item.node)}
              class:hard-dependency={item.node.hardDependency}
              class:dragging={draggedNode?.id === item.node.id}
              class={`status-${item.node.status}`}
              style={`grid-column: ${item.startColumn} / span ${item.spanColumns}; grid-row: ${item.row}`}
              title={nodeTooltip(item.node)}
              aria-label={`Open or reschedule ${formatNodeTitle(item.node)}`}
              onpointerdown={(event) => onNodePointerDown(event, item.node)}
              ondblclick={() => void onOpenSource(item.node)}
              onkeydown={(event) => onTimelineKeyDown(event, item.node)}
            >
              {#if !item.marker}
                <span class="pill-title">{formatNodeTitle(item.node)}</span>
              {/if}
              {#if isNodeOverdue(item.node)}
                <span class="warning-indicator" aria-label="Overdue">!</span>
              {/if}
              {#if item.node.hardDependency}
                <span class="fixed-indicator" aria-label="Fixed date">◆</span>
              {/if}
            </div>
          {/each}

          {#if datedNodes.length === 0}
            <p class="empty-hint">Drag here to create a task, or drop an item from Unscheduled.</p>
          {/if}
        </div>

        {#if isTodayVisible}
          <div
            class="today-line"
            style={`grid-column: ${todayColumn}`}
            title={`Today · ${todayDate()}`}
            aria-hidden="true"
          ></div>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .gantt {
    min-width: 0;
    color: var(--text-normal);
    background: var(--background-primary);
  }

  .gantt-scroll {
    overflow: auto;
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary);
  }

  .gantt-shell {
    --gantt-row-height: clamp(2.75rem, 6vh, 3.5rem);
    --gantt-header-height: clamp(2.5rem, 5vh, 3.25rem);
    --gantt-overview-height: clamp(4.5rem, 9vh, 6rem);
    display: grid;
    grid-template-columns: clamp(13rem, 25vw, 22rem) minmax(100%, max-content);
    width: max-content;
    min-width: 100%;
  }

  .task-rail {
    position: sticky;
    left: 0;
    z-index: 12;
    min-width: 0;
    border-right: var(--border-width) solid var(--border-color);
    background: var(--background-primary);
  }

  .overview-rail,
  .rail-header,
  .day-header {
    background: var(--background-secondary);
  }

  .overview-rail {
    display: flex;
    height: var(--gantt-overview-height);
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-2);
    padding-inline: var(--size-4-3);
    border-bottom: var(--border-width) solid var(--border-color);
    color: var(--text-normal);
  }

  .overview-rail span,
  .rail-header {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .rail-header,
  .day-header {
    position: sticky;
    top: 0;
    z-index: 6;
    height: var(--gantt-header-height);
  }

  .rail-header {
    display: flex;
    align-items: center;
    padding-inline: var(--size-4-3);
    font-weight: var(--font-semibold);
  }

  .task-list {
    display: grid;
    grid-template-rows: repeat(var(--row-count), var(--gantt-row-height));
  }

  .hierarchy-row,
  .task-row {
    min-width: 0;
    border: 0;
    border-bottom: var(--border-width) solid var(--border-color);
    border-radius: 0;
    color: var(--text-normal) !important;
    text-align: left;
  }

  .hierarchy-row {
    display: grid;
    grid-template-columns: min-content minmax(0, 1fr) min-content;
    align-items: center;
    gap: var(--size-2-2);
    padding-inline: var(--size-4-3);
    background: var(--background-secondary);
    cursor: pointer;
  }

  .project-row {
    padding-inline-start: var(--size-4-6);
    background: var(--background-primary-alt);
  }

  .hierarchy-row strong,
  .hierarchy-row > span:not(.disclosure) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hierarchy-row small,
  .disclosure {
    color: var(--text-muted);
  }

  .task-row {
    display: grid;
    grid-template-columns: min-content minmax(0, 1fr) min-content min-content;
    align-items: center;
    gap: var(--size-2-1);
    padding-inline: var(--size-4-2);
    background: var(--background-primary);
  }

  .task-row:hover,
  .task-row.selected {
    background: var(--background-modifier-hover);
  }

  .task-action {
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-normal) !important;
    box-shadow: none;
  }

  .source-action {
    overflow: hidden;
    text-align: left;
  }

  .source-action span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .checkbox-action,
  .scratchpad-action,
  .calendar-action {
    display: inline-grid;
    place-items: center;
    padding: var(--size-2-1);
    color: var(--text-muted) !important;
    cursor: pointer;
  }

  .checkbox-action:hover,
  .scratchpad-action:hover,
  .calendar-action:hover {
    color: var(--interactive-accent) !important;
  }

  .calendar-action.included {
    color: var(--interactive-accent) !important;
  }

  .calendar-action.excluded {
    color: var(--text-faint) !important;
  }

  .action-spacer {
    width: var(--size-4-4);
  }

  .subject-end {
    border-bottom-color: var(--interactive-accent);
  }

  .timeline-panel {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--day-count), minmax(var(--gantt-day-width), 1fr));
    grid-template-rows: var(--gantt-overview-height) var(--gantt-header-height) auto;
    width: max-content;
    min-width: 100%;
  }

  .overview-ribbon {
    position: relative;
    z-index: 2;
    grid-column: 1 / -1;
    grid-row: 1;
    overflow: hidden;
    border-bottom: var(--border-width) solid var(--border-color);
    background: var(--background-primary-alt);
  }

  .overview-ribbon::before {
    position: absolute;
    inset: 50% 0 auto;
    height: var(--border-width);
    background: var(--border-color);
    content: '';
  }

  .overview-item {
    --overview-step: calc(var(--size-4-2) + var(--size-2-1));
    position: absolute;
    top: calc(var(--size-2-2) + var(--overview-lane) * var(--overview-step));
    left: var(--overview-left);
    z-index: 2;
    min-width: var(--size-4-2);
    height: var(--size-4-2);
    padding: 0;
    transform: translateX(-50%);
    border: var(--border-width) solid var(--text-muted);
    border-radius: var(--radius-l);
    background: var(--background-secondary);
    color: var(--text-normal);
    cursor: pointer;
  }

  .overview-segment {
    width: max(var(--overview-width), var(--size-4-2));
    transform: none;
  }

  .overview-marker {
    transform: translateX(-50%) rotate(45deg);
    border-radius: var(--radius-s);
  }

  .overview-cluster {
    display: grid;
    width: var(--size-4-6);
    height: var(--size-4-6);
    place-items: center;
    font-size: var(--font-ui-smaller);
  }

  .overview-item:focus-visible,
  .overview-item:hover {
    z-index: 4;
    outline: var(--border-width) solid var(--interactive-accent);
    outline-offset: var(--size-2-1);
  }

  .day-header {
    display: grid;
    grid-column: 1 / -1;
    grid-row: 2;
    grid-template-columns: repeat(var(--day-count), minmax(var(--gantt-day-width), 1fr));
    min-width: max-content;
  }

  .day-header span {
    display: flex;
    min-width: var(--gantt-day-width);
    align-items: center;
    justify-content: center;
    padding-inline: var(--size-2-2);
    overflow: hidden;
    border-right: var(--border-width) solid var(--border-color);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .timeline-grid {
    position: relative;
    display: grid;
    grid-column: 1 / -1;
    grid-row: 3;
    grid-template-columns: repeat(var(--day-count), minmax(var(--gantt-day-width), 1fr));
    grid-template-rows: repeat(var(--row-count), var(--gantt-row-height));
    min-width: max-content;
    background: var(--background-primary);
    touch-action: none;
  }

  .timeline-grid.is-writing {
    cursor: wait;
  }

  .day-track {
    z-index: 0;
    min-width: var(--gantt-day-width);
    border-right: var(--border-width) solid var(--border-color);
  }

  .day-track.weekend {
    background: var(--background-secondary);
    opacity: var(--dimmed);
  }

  .today-line {
    position: relative;
    z-index: 10;
    grid-row: 1 / 4;
    justify-self: start;
    width: calc(var(--border-width) * 2);
    background: var(--interactive-accent);
    box-shadow: 0 0 var(--size-2-2) var(--interactive-accent);
    opacity: 0.75;
    pointer-events: none;
  }

  .row-track {
    z-index: 0;
    border-bottom: var(--border-width) solid var(--border-color);
    pointer-events: none;
  }

  .hierarchy-band {
    z-index: 1;
    border-bottom: var(--border-width) solid var(--border-color);
    background: var(--background-secondary);
  }

  .project-band {
    background: var(--background-primary-alt);
  }

  .subject-separator {
    z-index: 3;
    align-self: end;
    border-bottom: var(--border-width) solid var(--interactive-accent);
    pointer-events: none;
  }

  .collapsed-ribbon {
    --compact-item-size: var(--size-4-2);
    --compact-lane-step: calc(var(--compact-item-size) + var(--size-2-1));
    position: relative;
    z-index: 3;
    align-self: stretch;
    margin-inline: var(--size-2-2);
    overflow: hidden;
    pointer-events: none;
  }

  .collapsed-ribbon::before {
    position: absolute;
    inset: 50% 0 auto;
    height: var(--border-width);
    background: var(--border-color);
    content: '';
  }

  .collapsed-ribbon-item {
    position: absolute;
    top: calc(var(--size-2-1) + var(--compact-lane) * var(--compact-lane-step));
    left: var(--compact-left);
    z-index: 3;
    min-width: var(--compact-item-size);
    height: var(--compact-item-size);
    padding: 0;
    transform: translateX(-50%);
    border: var(--border-width) solid var(--text-muted);
    border-radius: var(--radius-l);
    background: var(--background-primary);
    color: var(--text-normal);
    cursor: pointer;
    pointer-events: auto;
  }

  .compact-segment {
    width: max(var(--compact-width), var(--compact-item-size));
    transform: none;
  }

  .compact-milestone {
    transform: translateX(-50%) rotate(45deg);
    border-radius: var(--radius-s);
  }

  .compact-cluster {
    display: grid;
    width: var(--size-4-6);
    height: var(--size-4-6);
    place-items: center;
    font-size: var(--font-ui-smaller);
  }

  .collapsed-ribbon-item:hover,
  .collapsed-ribbon-item:focus-visible {
    z-index: 5;
    outline: var(--border-width) solid var(--interactive-accent);
    outline-offset: var(--size-2-1);
  }

  .timeline-pill,
  .timeline-marker {
    z-index: 4;
    align-self: center;
    border: var(--border-width) solid var(--background-modifier-border);
    background: var(--background-secondary);
    color: var(--text-normal);
    box-shadow: var(--shadow-s);
    cursor: grab;
  }

  .timeline-pill {
    display: flex;
    min-width: 0;
    height: clamp(1.75rem, 60%, 2.5rem);
    align-items: center;
    gap: var(--size-2-1);
    margin-inline: var(--size-2-1);
    padding-inline: var(--size-4-3);
    overflow: hidden;
    border-radius: var(--radius-l);
    font-size: var(--font-ui-small);
  }

  .timeline-marker {
    position: relative;
    justify-self: center;
    width: var(--size-4-3);
    height: var(--size-4-3);
    border-radius: var(--radius-l);
  }

  .milestone-marker {
    transform: rotate(45deg);
    border-radius: var(--radius-s);
  }

  .timeline-pill:hover,
  .timeline-pill:focus-visible,
  .timeline-marker:hover,
  .timeline-marker:focus-visible,
  .item-selected {
    outline: var(--border-width) solid var(--interactive-accent);
    outline-offset: var(--size-2-1);
    box-shadow: var(--shadow-l);
  }

  .timeline-pill.dragging,
  .timeline-marker.dragging {
    cursor: grabbing;
    opacity: var(--dimmed);
  }

  .pill-title {
    display: block;
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .color-coded.status-todo {
    background-color: var(--status-todo);
    color: var(--text-on-accent);
  }

  .color-coded.status-in-progress {
    background-color: var(--status-in-progress);
    color: var(--text-on-accent);
  }

  .color-coded.status-done {
    background-color: var(--status-done);
    color: var(--text-on-accent);
  }

  .overdue {
    outline: calc(var(--border-width) * 2) solid var(--status-overdue);
    outline-offset: calc(var(--border-width) * -1);
  }

  .warning-indicator,
  .fixed-indicator {
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    color: currentColor;
    font-size: var(--font-ui-smaller);
    font-weight: var(--font-bold);
  }

  .timeline-marker .warning-indicator,
  .timeline-marker .fixed-indicator {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%) rotate(-45deg);
  }

  .timeline-marker:not(.milestone-marker) .warning-indicator,
  .timeline-marker:not(.milestone-marker) .fixed-indicator {
    transform: translate(-50%, -50%);
  }

  .hard-dependency {
    border-color: var(--background-modifier-border-focus);
    border-width: calc(var(--border-width) * 2);
  }

  .empty-hint {
    z-index: 1;
    grid-column: 1 / -1;
    grid-row: 2;
    align-self: center;
    justify-self: start;
    margin: 0 var(--size-4-4);
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    pointer-events: none;
  }

  @media (max-width: 64rem) {
    .gantt-shell {
      grid-template-columns: minmax(11rem, 22vw) minmax(100%, max-content);
    }

    .scratchpad-action {
      display: none;
    }

    .task-row {
      grid-template-columns: min-content minmax(0, 1fr) min-content;
    }
  }
</style>
