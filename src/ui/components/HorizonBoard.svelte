<script lang="ts">
  import { classifyHorizon, formatRelativeTaskDate } from '../../core/HorizonPlanner';
  import type { RoadmapNode } from '../../types';
  import TaskCard from './TaskCard.svelte';

  type HorizonColumn = 'now' | 'next' | 'later';
  const HORIZON_COLUMNS: readonly HorizonColumn[] = ['now', 'next', 'later'];

  let {
    nodes,
    enableColorCoding,
    nextDays,
    criticalDays,
    overduePreviewLimit,
    onEdit,
    onToggleComplete,
    onOpenSource,
  }: {
    nodes: readonly RoadmapNode[];
    enableColorCoding: boolean;
    nextDays: number;
    criticalDays: number;
    overduePreviewLimit: number;
    onEdit: (node: RoadmapNode) => void;
    onToggleComplete: (node: RoadmapNode, completed: boolean) => Promise<void>;
    onOpenSource: (node: RoadmapNode) => Promise<void>;
  } = $props();
  let showAllOverdue = $state(false);
  let plan = $derived(classifyHorizon(nodes, { nextDays, criticalDays }));
  let visibleOverdue = $derived(
    showAllOverdue ? plan.overdue : plan.overdue.slice(0, overduePreviewLimit),
  );
  let columns = $derived({
    now: [...visibleOverdue, ...plan.now],
    next: plan.next,
    later: plan.later,
  });

  function columnTitle(column: HorizonColumn): string {
    return column.charAt(0).toUpperCase() + column.slice(1);
  }

  function columnCount(column: HorizonColumn): number {
    return column === 'now' ? plan.overdue.length + plan.now.length : columns[column].length;
  }
</script>

<section class="horizon" aria-label="Horizon board">
  {#each HORIZON_COLUMNS as column (column)}
    <section class="horizon-column" aria-label={columnTitle(column)}>
      <header class="column-header">
        <h3>{columnTitle(column)}</h3>
        <span>{columnCount(column)}</span>
      </header>

      {#if column === 'now' && plan.overdue.length > 0}
        <div class="overdue-summary">
          <strong>Overdue · {plan.overdue.length}</strong>
          {#if plan.overdue.length > overduePreviewLimit}
            <button type="button" onclick={() => (showAllOverdue = !showAllOverdue)}>
              {showAllOverdue ? 'Show fewer' : 'Show all'}
            </button>
          {/if}
        </div>
      {/if}

      <div class="cards">
        {#if columns[column].length === 0}
          <p class="column-empty">Nothing here yet.</p>
        {:else}
          {#each columns[column] as node (node.id)}
            <TaskCard
              {node}
              {enableColorCoding}
              dateLabel={formatRelativeTaskDate(node)}
              {onToggleComplete}
              {onOpenSource}
              {onEdit}
            />
          {/each}
        {/if}
      </div>
    </section>
  {/each}
</section>

<style>
  .horizon {
    display: grid;
    grid-template-columns: repeat(3, minmax(min(18rem, 85vw), 1fr));
    gap: var(--size-4-3);
    overflow-x: auto;
  }

  .horizon-column {
    min-height: 14rem;
    max-height: calc(100vh - 12.5rem);
    padding: var(--size-4-3);
    overflow-y: auto;
    overscroll-behavior: contain;
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
  }

  .column-header,
  .overdue-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-2);
  }

  .column-header {
    margin-bottom: var(--size-4-3);
  }

  h3,
  p {
    margin: 0;
  }

  .column-header span,
  .column-empty {
    color: var(--text-muted);
  }

  .overdue-summary {
    margin-bottom: var(--size-4-2);
    padding: var(--size-4-2);
    border: var(--border-width) solid var(--status-overdue);
    border-radius: var(--radius-s);
    color: var(--text-error);
    font-size: var(--font-ui-small);
  }

  .overdue-summary button {
    padding: var(--size-2-1) var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    font: inherit;
    cursor: pointer;
  }

  .cards {
    display: grid;
    gap: var(--size-4-2);
  }

  .column-empty {
    padding: var(--size-4-2) 0;
  }

  @media (max-width: 64rem) {
    .horizon {
      display: flex;
    }

    .horizon-column {
      width: min(20rem, 82vw);
      flex: 0 0 auto;
    }
  }
</style>
