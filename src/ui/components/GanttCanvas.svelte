<script lang="ts">
  import { calculateBufferedDuration, calculateCalendarDaySpan } from '../../core/BufferCalculator';
  import type { RoadmapNode } from '../../types';

  let {
    nodes,
    scale,
    enableColorCoding,
    onReschedule,
    onSchedule,
    onCreate,
    onEdit,
  }: {
    nodes: readonly RoadmapNode[];
    scale: 'days' | 'weeks' | 'months';
    enableColorCoding: boolean;
    onReschedule: (node: RoadmapNode, startDate: string, dueDate: string) => Promise<void>;
    onSchedule: (node: RoadmapNode, startDate: string, dueDate: string) => Promise<void>;
    onCreate: (startDate: string, dueDate: string) => Promise<void>;
    onEdit: (node: RoadmapNode) => void;
  } = $props();

  const MILLISECONDS_PER_DAY = 86_400_000;
  const EMPTY_ROW_COUNT = 3;

  type ScheduledNode = RoadmapNode & { startDate: string; dueDate: string };

  interface Swimlane {
    key: string;
    label: string;
    nodes: readonly ScheduledNode[];
    headerRow: number;
    endRow: number;
  }

  interface HeaderSegment {
    key: string;
    label: string;
    startColumn: number;
    span: number;
  }

  let scheduledNodes = $derived(
    nodes
      .filter(isScheduled)
      .sort((left, right) => left.startDate.localeCompare(right.startDate)),
  );
  let groupedNodes = $derived(groupScheduledNodes(scheduledNodes));
  let swimlanes = $derived(buildSwimlanes(groupedNodes));
  let minimumDayCount = $derived(scale === 'days' ? 14 : scale === 'weeks' ? 84 : 365);
  let timelineStart = $derived(scheduledNodes[0]?.startDate ?? today());
  let timelineEnd = $derived(calculateTimelineEnd(scheduledNodes) ?? addDays(timelineStart, minimumDayCount - 1));
  let dayCount = $derived(Math.max(daysBetween(timelineStart, timelineEnd) + 1, minimumDayCount));
  let populatedRowCount = $derived(swimlanes.reduce((total, lane) => total + lane.nodes.length + 1, 0));
  let rowCount = $derived(Math.max(populatedRowCount, EMPTY_ROW_COUNT));
  let dayLabels = $derived(
    Array.from({ length: dayCount }, (_, index) => addDays(timelineStart, index)),
  );
  let headerSegments = $derived(buildHeaderSegments(dayLabels, scale));
  let timelineNodes = $derived(
    swimlanes.flatMap((lane) =>
      lane.nodes.map((node, index) => ({
        node,
        row: lane.headerRow + index + 1,
        startColumn: daysBetween(timelineStart, node.startDate) + 1,
        spanColumns: calculateBufferedDaySpan(node),
      })),
    ),
  );
  let rowNumbers = $derived(Array.from({ length: rowCount }, (_, index) => index + 1));

  let timelineBody = $state<HTMLDivElement>();
  let draggedNode = $state<RoadmapNode | null>(null);
  let creationStartDate = $state<string | null>(null);
  let creationStartX = $state<number | null>(null);
  let writing = $state(false);

  function isScheduled(node: RoadmapNode): node is ScheduledNode {
    return (
      node.startDate !== undefined &&
      node.dueDate !== undefined &&
      calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer) !== null
    );
  }

  function calculateBufferedDaySpan(node: ScheduledNode): number {
    const duration = calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer);
    return Math.max(1, Math.ceil(duration ?? 1));
  }

  function calculateTimelineEnd(items: readonly RoadmapNode[]): string | null {
    const endDates = items
      .map((node) => {
        if (!isScheduled(node)) {
          return undefined;
        }

        return addDays(node.startDate, calculateBufferedDaySpan(node) - 1);
      })
      .filter((date): date is string => date !== undefined);
    return endDates.sort().at(-1) ?? null;
  }

  function daysBetween(startDate: string, endDate: string): number {
    return (toUtcTimestamp(endDate) - toUtcTimestamp(startDate)) / MILLISECONDS_PER_DAY;
  }

  function addDays(date: string, days: number): string {
    return new Date(toUtcTimestamp(date) + days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
  }

  function toUtcTimestamp(date: string): number {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  }

  function formatDay(date: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      new Date(`${date}T00:00:00`),
    );
  }

  function groupScheduledNodes(items: readonly ScheduledNode[]): Map<string, ScheduledNode[]> {
    const grouped = new Map<string, ScheduledNode[]>();
    for (const node of items) {
      const subject = node.subject ?? 'Nezaradené';
      const subjectNodes = grouped.get(subject) ?? [];
      subjectNodes.push(node);
      grouped.set(subject, subjectNodes);
    }

    return new Map(
      Array.from(grouped.entries()).sort(([left], [right]) => {
        if (left === 'Nezaradené') return 1;
        if (right === 'Nezaradené') return -1;
        return formatSubject(left).localeCompare(formatSubject(right));
      }),
    );
  }

  function buildSwimlanes(groups: ReadonlyMap<string, readonly ScheduledNode[]>): Swimlane[] {
    let nextRow = 1;
    return Array.from(groups.entries()).map(([key, subjectNodes]) => {
      const headerRow = nextRow;
      const endRow = headerRow + subjectNodes.length;
      nextRow = endRow + 1;
      return {
        key,
        label: formatSubject(key),
        nodes: subjectNodes,
        headerRow,
        endRow,
      };
    });
  }

  function formatSubject(subject: string): string {
    if (subject === 'Nezaradené') {
      return subject;
    }

    const filename = subject.split('/').at(-1) ?? subject;
    return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
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

  function formatWeek(date: string): string {
    return formatWeekKey(date).split('-').at(-1) ?? formatWeekKey(date);
  }

  function formatWeekKey(date: string): string {
    const current = new Date(`${date}T00:00:00Z`);
    const day = current.getUTCDay() || 7;
    current.setUTCDate(current.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((current.getTime() - yearStart.getTime()) / MILLISECONDS_PER_DAY + 1) / 7);
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

  function isWeekend(date: string): boolean {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 || day === 6;
  }

  function today(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
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
    const dayIndex = Math.min(dayCount - 1, Math.max(0, Math.floor((event.clientX - bounds.left) / dayWidth)));
    return addDays(timelineStart, dayIndex);
  }

  function onNodePointerDown(event: PointerEvent, node: RoadmapNode): void {
    if (event.button !== 0 || writing) {
      return;
    }

    event.stopPropagation();
    draggedNode = node;
    timelineBody?.setPointerCapture(event.pointerId);
  }

  function onTimelinePointerDown(event: PointerEvent): void {
    if (writing || isTimelinePill(event.target) || isSwimlaneHeader(event.target)) {
      return;
    }

    creationStartDate = dateFromPointer(event);
    creationStartX = event.clientX;
    timelineBody?.setPointerCapture(event.pointerId);
  }

  function onTimelinePointerUp(event: PointerEvent): void {
    if (draggedNode !== null) {
      void persistReschedule(draggedNode, event);
      draggedNode = null;
      return;
    }

    if (creationStartDate !== null && creationStartX !== null) {
      const endDate = dateFromPointer(event);
      const minimumGesture = timelineBody === undefined ? 0 : timelineBody.getBoundingClientRect().width / dayCount / 4;
      if (endDate !== null && Math.abs(event.clientX - creationStartX) >= minimumGesture) {
        const startDate = creationStartDate <= endDate ? creationStartDate : endDate;
        const dueDate = creationStartDate <= endDate ? endDate : creationStartDate;
        void persistCreate(startDate, dueDate);
      }
    }

    clearPointerState();
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

  function onNodeKeyDown(event: KeyboardEvent, node: RoadmapNode): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onEdit(node);
    }
  }

  async function persistReschedule(node: RoadmapNode, event: PointerEvent): Promise<void> {
    const startDate = dateFromPointer(event);
    if (startDate === null || !isScheduled(node)) {
      return;
    }

    const span = calculateCalendarDaySpan(node.startDate, node.dueDate);
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

  function clearPointerState(): void {
    draggedNode = null;
    creationStartDate = null;
    creationStartX = null;
  }

  function isTimelinePill(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.timeline-pill') !== null;
  }

  function isSwimlaneHeader(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.swimlane-band') !== null;
  }
</script>

<section class="gantt" aria-label="Gantt timeline">
  <div class="gantt-scroll">
    <div class="gantt-shell" style={`--gantt-day-width: ${getDayWidth(scale)}`}>
      <aside class="task-rail" aria-label="Scheduled task list">
        <div class="rail-header">Tasks</div>
        <div class="task-list" style={`--row-count: ${rowCount}`}>
          {#each swimlanes as lane (lane.key)}
            <div class="swimlane-label" style={`grid-row: ${lane.headerRow}`} title={lane.key}>
              <span>{lane.label}</span>
            </div>
            {#each lane.nodes as node, index (node.id)}
              <button
                class:lane-end={index === lane.nodes.length - 1}
                style={`grid-row: ${lane.headerRow + index + 1}`}
                title={node.path}
                ondblclick={() => onEdit(node)}
              >
                <span>{node.title}</span>
              </button>
            {/each}
          {/each}
        </div>
      </aside>

      <div class="timeline-panel" style={`--day-count: ${dayCount}; --row-count: ${rowCount}`}>
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

          {#each swimlanes as lane (lane.key)}
            <div class="swimlane-band" style={`grid-column: 1 / -1; grid-row: ${lane.headerRow}`}></div>
            <div class="swimlane-separator" style={`grid-column: 1 / -1; grid-row: ${lane.endRow}`}></div>
          {/each}

          {#each timelineNodes as item (item.node.id)}
            <button
              class={`timeline-pill status-${item.node.status} ${item.node.hardDependency ? 'hard-dependency' : 'soft-dependency'}`}
              class:color-coded={enableColorCoding}
              class:dragging={draggedNode?.id === item.node.id}
              style={`grid-column: ${item.startColumn} / span ${item.spanColumns}; grid-row: ${item.row}`}
              title={item.node.title}
              aria-label={`Reschedule or edit ${item.node.title}`}
              onpointerdown={(event) => onNodePointerDown(event, item.node)}
              ondblclick={() => onEdit(item.node)}
              onkeydown={(event) => onNodeKeyDown(event, item.node)}
            >
              <span>{item.node.title}</span>
            </button>
          {/each}

          {#if scheduledNodes.length === 0}
            <p class="empty-hint">Drag here to create a task, or drop an item from Unscheduled.</p>
          {/if}
        </div>
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
    overflow-x: auto;
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary);
  }

  .gantt-shell {
    --gantt-row-height: clamp(2.75rem, 6vh, 3.5rem);
    --gantt-header-height: clamp(2.5rem, 5vh, 3.25rem);
    display: grid;
    grid-template-columns: clamp(13rem, 25vw, 22rem) minmax(100%, max-content);
    width: max-content;
    min-width: 100%;
  }

  .task-rail {
    position: sticky;
    left: 0;
    z-index: 10;
    min-width: 0;
    border-right: var(--border-width) solid var(--border-color);
    background: var(--background-primary);
  }

  .rail-header,
  .day-header {
    position: sticky;
    top: 0;
    z-index: 4;
    height: var(--gantt-header-height);
    background: var(--background-secondary);
  }

  .rail-header {
    display: flex;
    align-items: center;
    padding-inline: var(--size-4-3);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    font-weight: var(--font-semibold);
  }

  .task-list {
    display: grid;
    grid-template-rows: repeat(var(--row-count), var(--gantt-row-height));
  }

  .task-list button {
    min-width: 0;
    padding-inline: var(--size-4-3);
    overflow: hidden;
    border: 0;
    border-bottom: var(--border-width) solid var(--border-color);
    border-radius: 0;
    text-align: left;
    background: var(--background-primary);
    color: var(--text-normal);
  }

  .swimlane-label {
    display: flex;
    align-items: center;
    min-width: 0;
    padding-inline: var(--size-4-3);
    overflow: hidden;
    border-bottom: var(--border-width) solid var(--border-color);
    background: var(--background-secondary);
    color: var(--text-normal);
    font-weight: var(--font-semibold);
  }

  .swimlane-label span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-list button.lane-end {
    border-bottom-color: var(--interactive-accent);
  }

  .task-list button:hover {
    background: var(--background-modifier-hover);
  }

  .task-list span,
  .timeline-pill span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .timeline-panel {
    width: max-content;
    min-width: 100%;
  }

  .day-header {
    display: grid;
    grid-template-columns: repeat(var(--day-count), minmax(var(--gantt-day-width), 1fr));
    min-width: max-content;
  }

  .day-header span {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: var(--gantt-day-width);
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

  .row-track {
    z-index: 0;
    border-bottom: var(--border-width) solid var(--border-color);
    pointer-events: none;
  }

  .swimlane-band {
    z-index: 1;
    background: var(--background-secondary);
    border-bottom: var(--border-width) solid var(--border-color);
  }

  .swimlane-separator {
    z-index: 1;
    align-self: end;
    border-bottom: var(--border-width) solid var(--interactive-accent);
    pointer-events: none;
  }

  .timeline-pill {
    z-index: 2;
    align-self: center;
    min-width: 0;
    height: clamp(1.75rem, 60%, 2.5rem);
    margin-inline: var(--size-2-1);
    padding-inline: var(--size-4-3);
    overflow: hidden;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    background: var(--background-secondary);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    box-shadow: var(--shadow-s);
    cursor: grab;
  }

  .timeline-pill:hover,
  .timeline-pill:focus-visible {
    border-color: var(--interactive-accent);
    box-shadow: var(--shadow-l);
  }

  .timeline-pill.dragging {
    cursor: grabbing;
    opacity: var(--dimmed);
  }

  .timeline-pill.color-coded.status-todo {
    background-color: var(--status-todo);
    color: white;
  }

  .timeline-pill.color-coded.status-in-progress {
    background-color: var(--status-in-progress);
    color: white;
  }

  .timeline-pill.color-coded.status-done {
    background-color: var(--status-done);
    color: white;
  }

  .timeline-pill.hard-dependency {
    border-color: var(--background-modifier-border-focus);
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

  @media (max-width: 1024px) {
    .gantt-shell {
      grid-template-columns: 180px minmax(100%, max-content);
    }
  }
</style>
