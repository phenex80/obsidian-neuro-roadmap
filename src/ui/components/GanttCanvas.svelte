<script lang="ts">
  import { calculateBufferedDuration } from '../../core/BufferCalculator';
  import type { RoadmapNode } from '../../types';

  let {
    nodes,
    isInactive,
  }: { nodes: readonly RoadmapNode[]; isInactive: (path: string) => boolean } = $props();

  const DAY_WIDTH = 36;
  const ROW_HEIGHT = 46;
  const LABEL_WIDTH = 190;
  const HEADER_HEIGHT = 42;

  let scheduledNodes = $derived(
    nodes
      .filter(isScheduled)
      .sort((left, right) => left.startDate.localeCompare(right.startDate)),
  );
  let timelineStart = $derived(scheduledNodes[0]?.startDate ?? null);
  let timelineEnd = $derived(calculateTimelineEnd(scheduledNodes));
  let dayCount = $derived(
    timelineStart === null || timelineEnd === null ? 0 : daysBetween(timelineStart, timelineEnd) + 1,
  );
  let dayLabels = $derived(
    timelineStart === null ? [] : Array.from({ length: dayCount }, (_, index) => addDays(timelineStart, index)),
  );
  let timelineNodes = $derived(
    timelineStart === null
      ? []
      : scheduledNodes.map((node, index) => ({
          node,
          x: LABEL_WIDTH + daysBetween(timelineStart, node.startDate) * DAY_WIDTH,
          y: HEADER_HEIGHT + index * ROW_HEIGHT + 8,
          width: calculateNodeWidth(node),
        })),
  );
  let svgWidth = $derived(Math.max(LABEL_WIDTH + dayCount * DAY_WIDTH, 480));
  let svgHeight = $derived(Math.max(HEADER_HEIGHT + scheduledNodes.length * ROW_HEIGHT, 180));

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
</script>

<section class="gantt" aria-label="Gantt timeline">
  {#if scheduledNodes.length === 0}
    <p class="empty-state">No scheduled roadmap nodes match the current filters.</p>
  {:else}
    <div class="timeline-scroll">
      <svg
        class="timeline"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        role="img"
        aria-label="Roadmap timeline"
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
            />
            <text x={timelineNode.x + 8} y={timelineNode.y + 19} class="node-text">
              {truncate(timelineNode.node.title, Math.max(8, Math.floor(timelineNode.width / 8)))}
            </text>
          </g>
        {/each}
      </svg>
    </div>
  {/if}
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

  .empty-state {
    margin: 0;
    padding: var(--size-4-4);
    color: var(--text-muted);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
  }
</style>
