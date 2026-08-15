<script lang="ts">
  import { onMount } from 'svelte';
  import type { RoadmapIndexer } from '../../core/Indexer';
  import type { RoadmapNode } from '../../types';
  import type { EmbeddedRoadmapConfig } from '../embeddedRoadmap';
  import CircularDependencyAlert from './CircularDependencyAlert.svelte';

  let { indexer, config }: { indexer: RoadmapIndexer; config: EmbeddedRoadmapConfig } = $props();
  let nodes = $state<readonly RoadmapNode[]>([]);
  let indexReady = $state(false);
  let cycles = $state<readonly (readonly string[])[]>([]);
  let scopedNodes = $derived(
    config.subjectPath === undefined
      ? nodes
      : nodes.filter((node) => node.subject === config.subjectPath),
  );
  let scheduledNodes = $derived(
    scopedNodes
      .filter((node): node is RoadmapNode & { startDate: string; dueDate: string } =>
        node.startDate !== undefined && node.dueDate !== undefined,
      )
      .sort((left, right) => left.startDate.localeCompare(right.startDate)),
  );
  let unscheduledNodes = $derived(scopedNodes.filter((node) => node.startDate === undefined || node.dueDate === undefined));

  onMount(() =>
    indexer.subscribe((snapshot) => {
      nodes = snapshot.nodes;
      indexReady = snapshot.ready;
      cycles = indexer.getCircularDependencyCycles();
    }),
  );
</script>

<section class="embedded-roadmap" aria-label="Embedded roadmap">
  <header>
    <strong>Roadmap</strong>
    <span>{scopedNodes.length} {scopedNodes.length === 1 ? 'node' : 'nodes'}</span>
  </header>
  <CircularDependencyAlert {cycles} />

  {#if !indexReady}
    <p class="empty-state" role="status" aria-live="polite">Indexing roadmap…</p>
  {:else if scopedNodes.length === 0}
    <p class="empty-state">No roadmap nodes match this scope.</p>
  {:else if config.mode === 'gantt'}
    <ol class:compact={config.view === 'compact'} class="timeline-list">
      {#each scheduledNodes as node (node.id)}
        <li class={`status-${node.status} priority-${node.priority}`}>
          <strong>{node.title}</strong>
          <span>{node.startDate} → {node.dueDate} · {node.durationBuffer}× buffer</span>
        </li>
      {/each}
      {#if unscheduledNodes.length > 0}
        <li class="unscheduled-summary">{unscheduledNodes.length} unscheduled</li>
      {/if}
    </ol>
  {:else}
    <div class:compact={config.view === 'compact'} class="horizon-list">
      <section>
        <h4>Now</h4>
        {#each scopedNodes.filter((node) => node.status === 'in-progress').slice(0, 3) as node (node.id)}
          <p class={`status-${node.status} priority-${node.priority}`}>{node.title}</p>
        {:else}
          <p class="empty-column">Nothing active.</p>
        {/each}
      </section>
      <section>
        <h4>Next</h4>
        {#each scopedNodes.filter((node) => node.status === 'todo' && node.dueDate !== undefined) as node (node.id)}
          <p class={`status-${node.status} priority-${node.priority}`}>{node.title}</p>
        {:else}
          <p class="empty-column">Nothing scheduled.</p>
        {/each}
      </section>
      <section>
        <h4>Later</h4>
        {#each unscheduledNodes as node (node.id)}
          <p class={`status-${node.status} priority-${node.priority}`}>{node.title}</p>
        {:else}
          <p class="empty-column">No backlog items.</p>
        {/each}
      </section>
    </div>
  {/if}
</section>

<style>
  .embedded-roadmap {
    display: grid;
    gap: var(--size-4-3);
    padding: var(--size-4-3);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary);
    color: var(--text-normal);
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: var(--size-4-2);
  }

  header span,
  .empty-state,
  .empty-column,
  li span,
  .unscheduled-summary {
    color: var(--text-muted);
  }

  .timeline-list {
    display: grid;
    gap: var(--size-4-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .timeline-list li {
    display: grid;
    gap: var(--size-2-1);
    padding: var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-left-width: var(--border-width);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
  }

  .timeline-list.compact li {
    padding: var(--size-2-2);
  }

  .priority-low {
    opacity: var(--dimmed);
  }

  .priority-medium {
    opacity: 0.85;
  }

  .priority-high {
    border-left-color: var(--interactive-accent);
  }

  .status-todo {
    border-left-color: var(--status-todo);
  }

  .status-in-progress {
    border-left-color: var(--status-in-progress);
  }

  .status-done {
    border-left-color: var(--status-done);
  }

  .horizon-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(8rem, 1fr));
    gap: var(--size-4-2);
    overflow-x: auto;
  }

  .horizon-list section {
    display: grid;
    align-content: start;
    gap: var(--size-2-2);
    padding: var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
  }

  h4,
  p {
    margin: 0;
  }

  .horizon-list p:not(.empty-column) {
    padding-left: var(--size-2-2);
    border-left: var(--border-width) solid var(--border-color);
  }

  .horizon-list p.priority-low {
    opacity: var(--dimmed);
  }

  .horizon-list p.priority-medium {
    opacity: 0.85;
  }

  .horizon-list p.priority-high {
    border-left-color: var(--interactive-accent);
  }

  .horizon-list p.status-todo {
    border-left-color: var(--status-todo);
  }

  .horizon-list p.status-in-progress {
    border-left-color: var(--status-in-progress);
  }

  .horizon-list p.status-done {
    border-left-color: var(--status-done);
  }

  .horizon-list.compact {
    gap: var(--size-2-2);
  }
</style>
