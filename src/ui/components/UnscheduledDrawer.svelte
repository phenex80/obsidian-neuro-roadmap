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
    display: flex !important;
    width: 100% !important;
    box-sizing: border-box !important;
    flex-direction: column !important;
    align-items: flex-start !important;
    justify-content: flex-start !important;
    gap: 8px;
    height: auto !important;
    min-width: 0;
    min-height: min-content !important;
    padding: 12px !important;
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
    display: -webkit-box !important;
    width: 100% !important;
    flex: 0 0 auto;
    overflow: hidden !important;
    padding-bottom: 8px !important;
    color: var(--text-normal);
    font-size: var(--font-ui-medium);
    font-weight: 600 !important;
    line-height: 1.4 !important;
    text-align: left !important;
    white-space: normal !important;
    -webkit-box-orient: vertical !important;
    -webkit-line-clamp: 2 !important;
    line-clamp: 2 !important;
  }

  .metadata-row {
    display: flex !important;
    width: 100% !important;
    flex-wrap: wrap !important;
    gap: 6px !important;
    margin-top: auto !important;
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
