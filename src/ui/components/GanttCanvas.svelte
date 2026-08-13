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

  const DAY_WIDTH = 36;
  const ROW_HEIGHT = 46;
  const LABEL_WIDTH = 190;
  const HEADER_HEIGHT = 42;

  let scheduledNodes = $derived(
    nodes
      .filter(isScheduled)
      .sort((left, right) => left.startDate.localeCompare(right.startDate)),
  );
  let timelineStart = $derived(scheduledNodes[0]?.startDate ?? today());
  let timelineEnd = $derived(calculateTimelineEnd(scheduledNodes) ?? addDays(timelineStart, 13));
  let dayCount = $derived(
    daysBetween(timelineStart, timelineEnd) + 1,
  );
  let dayLabels = $derived(
    Array.from({ length: dayCount }, (_, index) => addDays(timelineStart, index)),
  );
  let timelineNodes = $derived(
    scheduledNodes.map((node, index) => ({
      node,
      x: LABEL_WIDTH + daysBetween(timelineStart, node.startDate) * DAY_WIDTH,
      y: HEADER_HEIGHT + index * ROW_HEIGHT + 8,
      width: calculateNodeWidth(node),
    })),
  );
  let svgWidth = $derived(Math.max(LABEL_WIDTH + dayCount * DAY_WIDTH, 480));
  let svgHeight = $derived(Math.max(HEADER_HEIGHT + scheduledNodes.length * ROW_HEIGHT, 180));
  let svgElement = $state<SVGSVGElement>();
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

  function calculateNodeWidth(node: RoadmapNode & { startDate: string; dueDate: string }): number {
    const duration = calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer);
    return Math.max(DAY_WIDTH, (duration ?? 1) * DAY_WIDTH);
  }

  function calculateTimelineEnd(items: readonly RoadmapNode[]): string | null {
    const endDates = items
      .map((node) => {
        if (!isScheduled(node)) {
          return undefined;
        }

        const duration = calculateBufferedDuration(node.startDate, node.dueDate, node.durationBuffer);
        return duration === null ? undefined : addDays(node.startDate, Math.ceil(duration) - 1);
      })
      .filter((date): date is string => date !== undefined);
    return endDates.sort().at(-1) ?? null;
  }

  function daysBetween(startDate: string, endDate: string): number {
    return (toUtcTimestamp(endDate) - toUtcTimestamp(startDate)) / 86_400_000;
  }

  function addDays(date: string, days: number): string {
    const result = new Date(toUtcTimestamp(date) + days * 86_400_000);
    return result.toISOString().slice(0, 10);
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

  function truncate(value: string, limit = 22): string {
    return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
  }

  function today(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())).toISOString().slice(0, 10);
  }

  function dateFromPointer(event: PointerEvent | DragEvent): string | null {
    if (svgElement === undefined) {
      return null;
    }

    const bounds = svgElement.getBoundingClientRect();
    if (bounds.width === 0) {
      return null;
    }

    const x = (event.clientX - bounds.left) * (svgWidth / bounds.width);
    const dayIndex = Math.max(0, Math.floor((x - LABEL_WIDTH) / DAY_WIDTH));
    return addDays(timelineStart, dayIndex);
  }

  function onNodePointerDown(event: PointerEvent, node: RoadmapNode): void {
    if (event.button !== 0 || writing) {
      return;
    }

    event.stopPropagation();
    draggedNode = node;
    svgElement?.setPointerCapture(event.pointerId);
  }

  function onTimelinePointerDown(event: PointerEvent): void {
    if (writing || !isTimelineBackground(event.target)) {
      return;
    }

    creationStartDate = dateFromPointer(event);
    creationStartX = event.clientX;
    svgElement?.setPointerCapture(event.pointerId);
  }

  function onTimelinePointerUp(event: PointerEvent): void {
    if (draggedNode !== null) {
      void persistReschedule(draggedNode, event);
      draggedNode = null;
      return;
    }

    if (creationStartDate !== null && creationStartX !== null) {
      const endDate = dateFromPointer(event);
      const hasDragged = Math.abs(event.clientX - creationStartX) >= 8;
      if (endDate !== null && hasDragged) {
        const startDate = creationStartDate <= endDate ? creationStartDate : endDate;
        const dueDate = creationStartDate <= endDate ? endDate : creationStartDate;
        void persistCreate(startDate, dueDate);
      }
    }

    clearCreationGesture();
  }

  function onTimelinePointerCancel(): void {
    draggedNode = null;
    clearCreationGesture();
  }

  function onTimelineDrop(event: DragEvent): void {
    event.preventDefault();
    const nodeId = event.dataTransfer?.getData('application/x-neuro-roadmap-node');
    const startDate = dateFromPointer(event);
    const node = nodeId === undefined ? undefined : nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined || startDate === null) {
      return;
    }

    void persistSchedule(node, startDate, startDate);
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
    if (writing) {
      return;
    }

    writing = true;
    try {
      await onSchedule(node, startDate, dueDate);
    } finally {
      writing = false;
    }
  }

  async function persistCreate(startDate: string, dueDate: string): Promise<void> {
    if (writing) {
      return;
    }

    writing = true;
    try {
      await onCreate(startDate, dueDate);
    } finally {
      writing = false;
    }
  }

  function clearCreationGesture(): void {
    creationStartDate = null;
    creationStartX = null;
  }

  function isTimelineBackground(target: EventTarget | null): target is SVGRectElement {
    return target instanceof SVGRectElement && target.classList.contains('timeline-background');
  }

  function onNodeKeyDown(event: KeyboardEvent, node: RoadmapNode): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onEdit(node);
    }
  }
</script>

<section class="gantt" aria-label="Gantt timeline">
  <div class="timeline-scroll">
    {#if scheduledNodes.length === 0}
      <p class="timeline-hint">Drag across the empty timeline to create a scheduled note, or drop an unscheduled task here.</p>
    {/if}
      <svg
        class="timeline"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        role="img"
        aria-label="Roadmap timeline"
        bind:this={svgElement}
        onpointerdown={onTimelinePointerDown}
        onpointerup={onTimelinePointerUp}
        onpointercancel={onTimelinePointerCancel}
        ondragover={(event) => event.preventDefault()}
        ondrop={onTimelineDrop}
      >
        <rect width={svgWidth} height={svgHeight} class="timeline-background" />
        {#each dayLabels as date, index (date)}
          <line
            x1={LABEL_WIDTH + index * DAY_WIDTH}
            x2={LABEL_WIDTH + index * DAY_WIDTH}
            y1="0"
            y2={svgHeight}
            class="day-line"
          />
          <text x={LABEL_WIDTH + index * DAY_WIDTH + 4} y="26" class="day-label">
            {formatDay(date)}
          </text>
        {/each}
        <line x1="0" x2={svgWidth} y1={HEADER_HEIGHT} y2={HEADER_HEIGHT} class="day-line" />
        {#each timelineNodes as timelineNode (timelineNode.node.id)}
          <g class:inactive={isInactive(timelineNode.node.path)}>
            <text x="12" y={timelineNode.y + 20} class="node-label">
              {truncate(timelineNode.node.title)}
            </text>
            <rect
              x={timelineNode.x}
              y={timelineNode.y}
              width={timelineNode.width}
              height="29"
              rx="5"
              class={`timeline-node energy-${timelineNode.node.energyLevel}`}
              role="button"
              tabindex="0"
              aria-label={`Reschedule or edit ${timelineNode.node.title}`}
              onpointerdown={(event) => onNodePointerDown(event, timelineNode.node)}
              ondblclick={() => onEdit(timelineNode.node)}
              onkeydown={(event) => onNodeKeyDown(event, timelineNode.node)}
            />
            <text x={timelineNode.x + 8} y={timelineNode.y + 19} class="node-text">
              {truncate(timelineNode.node.title, Math.max(8, Math.floor(timelineNode.width / 8)))}
            </text>
          </g>
        {/each}
      </svg>
  </div>
</section>

<style>
  .gantt {
    min-width: 0;
    background: var(--background-primary);
    color: var(--text-normal);
  }

  .timeline-scroll {
    overflow: auto;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary);
  }

  .timeline-hint {
    margin: 0;
    padding: var(--size-4-2) var(--size-4-3);
    color: var(--text-muted);
    background: var(--background-secondary);
  }

  .timeline {
    display: block;
    font-family: var(--font-interface);
  }

  .timeline-background {
    fill: var(--background-primary);
  }

  .day-line {
    stroke: var(--border-color);
    stroke-width: 1;
  }

  .day-label,
  .node-label {
    fill: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .node-label {
    fill: var(--text-normal);
  }

  .timeline-node {
    stroke: var(--border-color);
    stroke-width: 1;
  }

  .timeline-node.energy-low {
    fill: var(--color-green);
    opacity: 0.7;
  }

  .timeline-node.energy-medium {
    fill: var(--color-yellow);
    opacity: 0.85;
  }

  .timeline-node.energy-high {
    fill: var(--color-orange);
    opacity: 1;
  }

  .node-text {
    fill: var(--text-on-accent);
    font-size: var(--font-ui-smaller);
    pointer-events: none;
  }

  g.inactive {
    opacity: 0.35;
  }

</style>
