<script lang="ts">
  import { calculateCalendarDaySpan } from '../../core/BufferCalculator';
  import type { RoadmapNode } from '../../types';

  let {
    nodes,
    enableColorCoding,
    onEdit,
  }: {
    nodes: readonly RoadmapNode[];
    enableColorCoding: boolean;
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
        <li>
          <button
            type="button"
            class={`task-card status-${node.status}`}
            class:color-coded={enableColorCoding}
            title={node.path}
            draggable="true"
            ondragstart={(event) => onDragStart(event, node)}
            ondblclick={() => onEdit(node)}
            onkeydown={(event) => onCardKeyDown(event, node)}
          >
            <strong class="card-title">
              {node.title ? node.title : (node.path ? (node.path.split('/').pop()?.replace('.md', '') ?? 'Neznáma úloha') : 'Neznáma úloha')}
            </strong>
            <span class="metadata-row">
              <span class={`metadata-badge status-badge status-${node.status}`}>{formatLabel(node.status)}</span>
              <span class={`metadata-badge priority-badge priority-${node.priority}`}>
                {formatLabel(node.priority)} priority
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

  h3 {
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
    width: 100%;
    box-sizing: border-box;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 8px;
    min-width: 0;
    padding: var(--size-4-3);
    overflow: hidden;
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

  .task-card.color-coded.status-todo {
    border-inline-start-color: var(--status-todo);
  }

  .task-card.color-coded.status-in-progress {
    border-inline-start-color: var(--status-in-progress);
  }

  .task-card.color-coded.status-done {
    border-inline-start-color: var(--status-done);
  }

  .color-coded .status-badge.status-todo {
    background: var(--status-todo);
    color: white;
  }

  .card-title {
    display: -webkit-box;
    width: 100%;
    flex: 0 0 auto;
    overflow: hidden;
    margin-bottom: var(--size-2-2);
    color: var(--text-normal);
    font-size: var(--font-ui-medium);
    font-weight: 600;
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .metadata-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
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

  .color-coded .status-badge.status-in-progress {
    background: var(--status-in-progress);
    color: white;
  }

  .color-coded .status-badge.status-done {
    background: var(--status-done);
    color: white;
  }

  .color-coded .priority-badge.priority-high {
    background: var(--priority-high);
    color: white;
  }

  .color-coded .priority-badge.priority-medium {
    background: var(--priority-medium);
    color: white;
  }

  .color-coded .priority-badge.priority-low {
    background: var(--priority-low);
    color: var(--text-normal);
  }
</style>
