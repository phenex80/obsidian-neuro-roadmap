<script lang="ts">
  import { calculateBufferedDuration, calculateCalendarDaySpan } from '../../core/BufferCalculator';
  import type { RoadmapNode } from '../../types';

  let {
    nodes,
    isInactive,
    onReschedule,
    onSchedule,
    onCreate,
    onEdit,
  }: {
    nodes: readonly RoadmapNode[];
    isInactive: (path: string) => boolean;
    onReschedule: (node: RoadmapNode, startDate: string, dueDate: string) => Promise<void>;
    onSchedule: (node: RoadmapNode, startDate: string, dueDate: string) => Promise<void>;
    onCreate: (startDate: string, dueDate: string) => Promise<void>;
    onEdit: (node: RoadmapNode) => void;
  } = $props();

  const MILLISECONDS_PER_DAY = 86_400_000;
  const MINIMUM_DAY_COUNT = 14;
  const EMPTY_ROW_COUNT = 3;

  let scheduledNodes = $derived(
    nodes
      .filter(isScheduled)
      .sort((left, right) => left.startDate.localeCompare(right.startDate)),
  );
  let timelineStart = $derived(scheduledNodes[0]?.startDate ?? today());
  let timelineEnd = $derived(calculateTimelineEnd(scheduledNodes) ?? addDays(timelineStart, MINIMUM_DAY_COUNT - 1));
  let dayCount = $derived(Math.max(daysBetween(timelineStart, timelineEnd) + 1, MINIMUM_DAY_COUNT));
  let rowCount = $derived(Math.max(scheduledNodes.length, EMPTY_ROW_COUNT));
  let dayLabels = $derived(
    Array.from({ length: dayCount }, (_, index) => addDays(timelineStart, index)),
  );
  let timelineNodes = $derived(
    scheduledNodes.map((node, index) => ({
      node,
      row: index + 1,
      startColumn: daysBetween(timelineStart, node.startDate) + 1,
      spanColumns: calculateBufferedDaySpan(node),
    })),
  );

  let timelineBody = $state<HTMLDivElement>();
  let draggedNode = $state<RoadmapNode | null>(null);
  let creationStartDate = $state<string | null>(null);
  let creationStartX = $state<number | null>(null);
  let writing = $state(false);

  function isScheduled(node: RoadmapNode): node is RoadmapNode & { startDate: string; dueDate: string } {
    return (
      node.startDate !== undefined &&
      node.dueDate !== undefined &&
      calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer) !== null
    );
  }

  function calculateBufferedDaySpan(node: RoadmapNode & { startDate: string; dueDate: string }): number {
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
    if (writing || isTimelinePill(event.target)) {
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
</script>

<section class="gantt" aria-label="Gantt timeline">
  <div class="gantt-scroll">
    <div class="gantt-shell">
      <aside class="task-rail" aria-label="Scheduled task list">
        <div class="rail-header">Tasks</div>
        <div class="task-list" style={`--row-count: ${rowCount}`}>
          {#each scheduledNodes as node (node.id)}
            <button
              class:inactive={isInactive(node.path)}
              title={node.path}
              ondblclick={() => onEdit(node)}
            >
              <span>{node.title}</span>
            </button>
          {/each}
        </div>
      </aside>

      <div class="timeline-panel" style={`--day-count: ${dayCount}; --row-count: ${rowCount}`}>
        <div class="day-header" aria-hidden="true">
          {#each dayLabels as date (date)}
            <span title={date}>{formatDay(date)}</span>
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
            <div class="day-track" style={`grid-column: ${index + 1}; grid-row: 1 / -1`} title={date}></div>
          {/each}

          {#each timelineNodes as item (item.node.id)}
            <button
              class={`timeline-pill energy-${item.node.energyLevel} ${item.node.hardDependency ? 'hard-dependency' : 'soft-dependency'}`}
              class:inactive={isInactive(item.node.path)}
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
    --gantt-day-width: clamp(4.5rem, 7vw, 6rem);
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

  .timeline-pill {
    z-index: 2;
    align-self: center;
    min-width: 0;
    height: clamp(1.75rem, 60%, 2.5rem);
    margin-inline: var(--size-2-1);
    padding-inline: var(--size-4-3);
    overflow: hidden;
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-l);
    background: var(--interactive-normal);
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    box-shadow: var(--shadow-s);
    cursor: grab;
  }

  .timeline-pill:hover,
  .timeline-pill:focus-visible {
    border-color: var(--interactive-accent);
    background: var(--interactive-hover);
  }

  .timeline-pill.dragging {
    cursor: grabbing;
    opacity: var(--dimmed);
  }

  .timeline-pill.energy-low {
    opacity: 0.7;
  }

  .timeline-pill.energy-medium {
    opacity: 0.85;
  }

  .timeline-pill.energy-high,
  .timeline-pill.hard-dependency {
    border-color: var(--interactive-accent);
  }

  .timeline-pill.soft-dependency {
    border-style: dashed;
  }

  .inactive {
    opacity: var(--dimmed);
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
</style>
