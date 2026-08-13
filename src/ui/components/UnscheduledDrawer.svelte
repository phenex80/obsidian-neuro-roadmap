<script lang="ts">
  import { calculateCalendarDaySpan } from '../../core/BufferCalculator';
  import type { RoadmapNode } from '../../types';

  let {
    nodes,
    isInactive,
    onEdit,
  }: {
    nodes: readonly RoadmapNode[];
    isInactive: (path: string) => boolean;
    onEdit: (node: RoadmapNode) => void;
  } = $props();
  let unscheduledNodes = $derived(nodes.filter((node) => !hasValidDates(node)));

  function hasValidDates(node: RoadmapNode): boolean {
    return (
      node.startDate !== undefined &&
      node.dueDate !== undefined &&
      calculateCalendarDaySpan(node.startDate, node.dueDate) !== null
    );
  }

  function onDragStart(event: DragEvent, node: RoadmapNode): void {
    const transfer = event.dataTransfer;
    if (transfer !== null) {
      transfer.setData('application/x-neuro-roadmap-node', node.id);
      transfer.effectAllowed = 'move';
    }
  }

  function formatLabel(value: string): string {
    return value.replace('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
  }

  function onCardKeyDown(event: KeyboardEvent, node: RoadmapNode): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onEdit(node);
    }
  }
</script>

<aside class="unscheduled-drawer" aria-label="Unscheduled nodes">
  <header>
    <h3>Unscheduled</h3>
    <span>{unscheduledNodes.length}</span>
  </header>
  {#if unscheduledNodes.length === 0}
    <p>Every visible node has valid dates.</p>
  {:else}
    <ul>
      {#each unscheduledNodes as node (node.id)}
        <li class:inactive={isInactive(node.path)}>
          <button
            type="button"
            class="task-card"
            title={node.path}
            draggable="true"
            ondragstart={(event) => onDragStart(event, node)}
            ondblclick={() => onEdit(node)}
            onkeydown={(event) => onCardKeyDown(event, node)}
          >
            <strong>{node.title}</strong>
            <span class="metadata-row">
              <span class="metadata-badge">{formatLabel(node.status)}</span>
              <span class={`metadata-badge energy-badge energy-${node.energyLevel}`}>
                {formatLabel(node.energyLevel)} energy
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .unscheduled-drawer {
    align-self: start;
    padding: var(--size-4-3);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--size-4-2);
  }

  h3,
  p,
  ul {
    margin: 0;
  }

  h3,
  strong {
    color: var(--text-normal);
  }

  header span,
  p {
    color: var(--text-muted);
  }

  ul {
    display: grid;
    gap: var(--size-4-2);
    padding: 0;
    list-style: none;
  }

  .task-card {
    display: flex;
    flex-direction: column;
    gap: var(--size-4-3);
    min-width: 0;
    padding: var(--size-4-3);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    font: inherit;
    text-align: left;
    cursor: grab;
    transition: border-color var(--anim-duration-fast) var(--anim-motion-swing);
  }

  .task-card:hover,
  .task-card:focus-visible {
    border-color: var(--interactive-accent);
  }

  .task-card:active {
    cursor: grabbing;
  }

  li.inactive {
    opacity: var(--dimmed);
  }

  .task-card strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metadata-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2-2);
    margin-top: auto;
  }

  .metadata-badge {
    display: inline-flex;
    align-items: center;
    width: max-content;
    padding: var(--size-2-1) var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-l);
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .energy-badge.energy-low {
    opacity: 0.7;
  }

  .energy-badge.energy-medium {
    opacity: 0.85;
  }

  .energy-badge.energy-high {
    border-color: var(--interactive-accent);
    color: var(--text-normal);
  }
</style>
