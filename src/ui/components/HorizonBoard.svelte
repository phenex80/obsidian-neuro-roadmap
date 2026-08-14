<script lang="ts">
  import type { RoadmapNode } from '../../types';

  type HorizonColumn = 'now' | 'next' | 'later';
  const HORIZON_COLUMNS: readonly HorizonColumn[] = ['now', 'next', 'later'];

  let {
    nodes,
    enableColorCoding,
    onEdit,
  }: {
    nodes: readonly RoadmapNode[];
    enableColorCoding: boolean;
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
            <button
              type="button"
              class={`roadmap-card status-${node.status}`}
              class:color-coded={enableColorCoding}
              title={node.path}
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
          {/each}
        {/if}
      </div>
    </section>
  {/each}
</section>

<style>
  .horizon {
    display: grid;
    grid-template-columns: repeat(3, minmax(clamp(12rem, 24vw, 20rem), 1fr));
    gap: var(--size-4-3);
    overflow-x: auto;
  }

  .horizon-column {
    min-height: 14rem;
    max-height: calc(100vh - 200px);
    padding: var(--size-4-3);
    overflow-y: auto;
    border: var(--border-width) solid var(--border-color);
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
  p {
    margin: 0;
  }

  h3 {
    color: var(--text-normal);
  }

  header span,
  .column-empty {
    color: var(--text-muted);
  }

  .cards {
    display: grid;
    gap: var(--size-4-2);
  }

  .roadmap-card {
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
    cursor: pointer;
    transition: border-color var(--anim-duration-fast) var(--anim-motion-swing);
  }

  .roadmap-card:hover,
  .roadmap-card:focus-visible {
    border-color: var(--interactive-accent);
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

  .roadmap-card.color-coded.status-todo {
    border-inline-start-color: var(--status-todo);
  }

  .roadmap-card.color-coded.status-in-progress {
    border-inline-start-color: var(--status-in-progress);
  }

  .roadmap-card.color-coded.status-done {
    border-inline-start-color: var(--status-done);
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

  .color-coded .status-badge.status-todo {
    background: var(--status-todo);
    color: white;
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

  .column-empty {
    padding: var(--size-4-2) 0;
  }

  @media (max-width: 1024px) {
    .horizon {
      display: flex;
      grid-template-columns: minmax(280px, 1fr);
      overflow-x: auto;
    }

    .horizon-column {
      min-width: 280px;
      flex-shrink: 0;
    }
  }
</style>
