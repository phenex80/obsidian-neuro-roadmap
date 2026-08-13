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
        <li
          class:inactive={isInactive(node.path)}
          draggable="true"
          ondragstart={(event) => onDragStart(event, node)}
          ondblclick={() => onEdit(node)}
        >
          <span class={`energy-indicator energy-${node.energyLevel}`}></span>
          <div>
            <strong>{node.title}</strong>
            <small>{node.path}</small>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .unscheduled-drawer {
    padding: var(--size-4-3);
    border: 1px solid var(--border-color);
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
  p,
  small {
    color: var(--text-muted);
  }

  ul {
    display: grid;
    gap: var(--size-4-2);
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--size-4-2);
    align-items: start;
    padding: var(--size-4-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-primary);
  }

  li.inactive {
    opacity: 0.35;
  }

  small {
    display: block;
    margin-top: var(--size-2-1);
  }

  .energy-indicator {
    width: var(--size-4-2);
    height: var(--size-4-2);
    margin-top: var(--size-2-1);
    border-radius: var(--radius-round);
  }

  .energy-indicator.energy-low {
    background: var(--color-green);
    opacity: 0.7;
  }

  .energy-indicator.energy-medium {
    background: var(--color-yellow);
    opacity: 0.85;
  }

  .energy-indicator.energy-high {
    background: var(--color-orange);
  }
</style>
