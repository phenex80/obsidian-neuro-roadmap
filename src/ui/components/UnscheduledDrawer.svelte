<script lang="ts">
  import { classifyHorizon } from '../../core/HorizonPlanner';
  import type { RoadmapNode } from '../../types';
  import TaskCard from './TaskCard.svelte';

  let {
    nodes,
    enableColorCoding,
    onEdit,
    onToggleComplete,
    onOpenSource,
  }: {
    nodes: readonly RoadmapNode[];
    enableColorCoding: boolean;
    onEdit: (node: RoadmapNode) => void;
    onToggleComplete: (node: RoadmapNode, completed: boolean) => Promise<void>;
    onOpenSource: (node: RoadmapNode) => Promise<void>;
  } = $props();
  let unscheduledNodes = $derived(
    classifyHorizon(nodes, { nextDays: 7, criticalDays: 0 }).unscheduled,
  );

  function onDragStart(event: DragEvent, node: RoadmapNode): void {
    const transfer = event.dataTransfer;
    if (transfer !== null) {
      transfer.setData('application/x-neuro-roadmap-node', node.id);
      transfer.effectAllowed = 'move';
    }
  }
</script>

<aside class="unscheduled-drawer" aria-label="Unscheduled tasks">
  <header>
    <div>
      <h3>Unscheduled</h3>
      <p>Inbox · no usable dates</p>
    </div>
    <span>{unscheduledNodes.length}</span>
  </header>
  {#if unscheduledNodes.length === 0}
    <p class="empty-state">Every visible task has a usable date.</p>
  {:else}
    <ul class="unscheduled-list">
      {#each unscheduledNodes as node (node.id)}
        <li>
          <TaskCard
            {node}
            {enableColorCoding}
            dateLabel="No schedule"
            draggable={true}
            {onDragStart}
            {onToggleComplete}
            {onOpenSource}
            {onEdit}
          />
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .unscheduled-drawer {
    display: flex;
    max-height: calc(100vh - 12.5rem);
    box-sizing: border-box;
    flex-direction: column;
    align-self: start;
    padding: var(--size-4-3);
    overflow: hidden;
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
  }

  header {
    display: flex;
    flex: 0 0 auto;
    align-items: start;
    justify-content: space-between;
    gap: var(--size-4-2);
    margin-bottom: var(--size-4-2);
  }

  h3,
  p,
  ul {
    margin: 0;
  }

  header p,
  header > span,
  .empty-state {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .unscheduled-list {
    display: grid;
    width: 100%;
    min-height: 0;
    box-sizing: border-box;
    flex: 1 1 auto;
    gap: var(--size-4-2);
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    list-style: none;
  }

  .empty-state {
    padding-block: var(--size-4-2);
  }
</style>
