<script lang="ts">
  import type { RoadmapNode } from '../../types';

  type HorizonColumn = 'now' | 'next' | 'later';
  const HORIZON_COLUMNS: readonly HorizonColumn[] = ['now', 'next', 'later'];

  let {
    nodes,
    isInactive,
    onEdit,
  }: {
    nodes: readonly RoadmapNode[];
    isInactive: (path: string) => boolean;
    onEdit: (node: RoadmapNode) => void;
  } = $props();

  let columns = $derived({
    now: getNowNodes(nodes),
    next: getNextNodes(nodes),
    later: getLaterNodes(nodes),
  });

  function getNowNodes(items: readonly RoadmapNode[]): RoadmapNode[] {
    return items
      .filter((node) => node.status === 'in-progress')
      .sort(compareByUrgency)
      .slice(0, 3);
  }

  function getNextNodes(items: readonly RoadmapNode[]): RoadmapNode[] {
    const nowIds = new Set(getNowNodes(items).map((node) => node.id));
    return items
      .filter((node) => !nowIds.has(node.id) && node.status !== 'done' && node.dueDate !== undefined)
      .sort(compareByUrgency);
  }

  function getLaterNodes(items: readonly RoadmapNode[]): RoadmapNode[] {
    const nowIds = new Set(getNowNodes(items).map((node) => node.id));
    const nextIds = new Set(getNextNodes(items).map((node) => node.id));
    return items
      .filter((node) => !nowIds.has(node.id) && !nextIds.has(node.id) && node.status !== 'done')
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  function compareByUrgency(left: RoadmapNode, right: RoadmapNode): number {
    return (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31');
  }

  function columnTitle(column: HorizonColumn): string {
    return column.charAt(0).toUpperCase() + column.slice(1);
  }
</script>

<section class="horizon" aria-label="Horizon board">
  {#each HORIZON_COLUMNS as column (column)}
    <section class="horizon-column" aria-label={columnTitle(column)}>
      <header>
        <h3>{columnTitle(column)}</h3>
        <span>{columns[column].length}</span>
      </header>
      <div class="cards">
        {#if columns[column].length === 0}
          <p class="column-empty">Nothing here yet.</p>
        {:else}
          {#each columns[column] as node (node.id)}
            <article
              class={`roadmap-card energy-${node.energyLevel}`}
              class:inactive={isInactive(node.path)}
              ondblclick={() => onEdit(node)}
            >
              <h4>{node.title}</h4>
              <p>{node.dueDate === undefined ? 'Unscheduled' : `Due ${node.dueDate}`}</p>
            </article>
          {/each}
        {/if}
      </div>
    </section>
  {/each}
</section>

<style>
  .horizon {
    display: grid;
    grid-template-columns: repeat(3, minmax(12rem, 1fr));
    gap: var(--size-4-3);
    overflow-x: auto;
  }

  .horizon-column {
    min-height: 14rem;
    padding: var(--size-4-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--size-4-3);
  }

  h3,
  h4,
  p {
    margin: 0;
  }

  h3,
  h4 {
    color: var(--text-normal);
  }

  header span,
  p {
    color: var(--text-muted);
  }

  .cards {
    display: grid;
    gap: var(--size-4-2);
  }

  .roadmap-card {
    padding: var(--size-4-3);
    border: 1px solid var(--border-color);
    border-left-width: var(--border-width);
    border-radius: var(--radius-s);
    background: var(--background-primary);
  }

  .roadmap-card.energy-low {
    border-left-color: var(--color-green);
    opacity: 0.7;
  }

  .roadmap-card.energy-medium {
    border-left-color: var(--color-yellow);
    opacity: 0.85;
  }

  .roadmap-card.energy-high {
    border-left-color: var(--color-orange);
    opacity: 1;
  }

  .roadmap-card.inactive {
    opacity: 0.35;
  }

  .column-empty {
    padding: var(--size-4-2) 0;
  }
</style>
