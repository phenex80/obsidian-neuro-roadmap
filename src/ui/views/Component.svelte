<script lang="ts">
  import { onMount } from 'svelte';
  import type { App } from 'obsidian';
  import type { RoadmapNode } from '../../types';
  import type { RoadmapIndexer } from '../../core/Indexer';
  import type { RoadmapScheduler } from '../../core/RoadmapScheduler';
  import GanttCanvas from '../components/GanttCanvas.svelte';
  import HorizonBoard from '../components/HorizonBoard.svelte';
  import UnscheduledDrawer from '../components/UnscheduledDrawer.svelte';
  import ScratchpadPopover from '../components/ScratchpadPopover.svelte';
  import CircularDependencyAlert from '../components/CircularDependencyAlert.svelte';

  let {
    app,
    indexer,
    scheduler,
  }: { app: App; indexer: RoadmapIndexer; scheduler: RoadmapScheduler } = $props();
  let nodes = $state<readonly RoadmapNode[]>([]);
  let semester = $state('all');
  let energyLevel = $state<'all' | 'low' | 'medium' | 'high'>('all');
  let viewMode = $state<'gantt' | 'horizon'>('gantt');
  let focusMode = $state(false);
  let scratchpadNode = $state<RoadmapNode | null>(null);
  let circularDependencyCycles = $state<readonly (readonly string[])[]>([]);
  const ENERGY_FILTERS = ['all', 'low', 'medium', 'high'] as const;

  let semesters = $derived(
    Array.from(
      new Set(
        nodes
          .map((node) => node.semester)
          .filter((value): value is string => value !== undefined),
      ),
    ).sort(),
  );
  let filteredNodes = $derived(
    nodes.filter(
      (node) =>
        (semester === 'all' || node.semester === semester) &&
        (energyLevel === 'all' || node.energyLevel === energyLevel),
    ),
  );
  let activePaths = $derived(
    focusMode
      ? new Set(filteredNodes.filter((node) => node.status === 'in-progress').map((node) => node.path))
      : null,
  );

  onMount(() =>
    indexer.subscribe((updatedNodes) => {
      nodes = updatedNodes;
      circularDependencyCycles = indexer.getCircularDependencyCycles();
    }),
  );

  function isInactive(path: string): boolean {
    return activePaths !== null && !activePaths.has(path);
  }

  function openScratchpad(node: RoadmapNode): void {
    scratchpadNode = node;
  }

  async function appendScratchpad(text: string): Promise<void> {
    if (scratchpadNode !== null) {
      await scheduler.appendScratchpad(scratchpadNode, text);
    }
  }
</script>

<main class="roadmap-workspace">
  <header class="toolbar">
    <label>
      <span>Semester</span>
      <select bind:value={semester} aria-label="Semester filter">
        <option value="all">All semesters</option>
        {#each semesters as availableSemester (availableSemester)}
          <option value={availableSemester}>{availableSemester}</option>
        {/each}
      </select>
    </label>

    <div class="filter-group" aria-label="Energy level filter">
      <span>Energy</span>
      {#each ENERGY_FILTERS as level (level)}
        <button
          class:active={energyLevel === level}
          aria-pressed={energyLevel === level}
          onclick={() => (energyLevel = level)}
        >
          {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
        </button>
      {/each}
    </div>

    <div class="filter-group" aria-label="Roadmap view mode">
      <span>View</span>
      <button class:active={viewMode === 'gantt'} aria-pressed={viewMode === 'gantt'} onclick={() => (viewMode = 'gantt')}>
        Gantt
      </button>
      <button class:active={viewMode === 'horizon'} aria-pressed={viewMode === 'horizon'} onclick={() => (viewMode = 'horizon')}>
        Horizon
      </button>
    </div>

    <button class:active={focusMode} aria-pressed={focusMode} onclick={() => (focusMode = !focusMode)}>
      Focus active tasks
    </button>
  </header>

  <p class="scope-summary">
    {filteredNodes.length} {filteredNodes.length === 1 ? 'node' : 'nodes'} in scope
    {#if focusMode}
      · non-active tasks are dimmed
    {/if}
  </p>

  <CircularDependencyAlert cycles={circularDependencyCycles} />

  <div class="roadmap-layout">
    <div class="main-panel">
      {#if viewMode === 'gantt'}
        <GanttCanvas
          nodes={filteredNodes}
          {isInactive}
          onReschedule={(node, startDate, dueDate) => scheduler.rescheduleNode(node, startDate, dueDate)}
          onSchedule={(node, startDate, dueDate) => scheduler.scheduleUnscheduledNode(node, startDate, dueDate)}
          onCreate={(startDate, dueDate) => scheduler.createNode(startDate, dueDate)}
          onEdit={openScratchpad}
        />
      {:else}
        <HorizonBoard nodes={filteredNodes} {isInactive} onEdit={openScratchpad} />
      {/if}
    </div>
    <UnscheduledDrawer nodes={filteredNodes} {isInactive} onEdit={openScratchpad} />
  </div>
</main>

{#if scratchpadNode !== null}
  <ScratchpadPopover
    {app}
    node={scratchpadNode}
    onSave={appendScratchpad}
    onClose={() => (scratchpadNode = null)}
  />
{/if}

<style>
  .roadmap-workspace {
    display: grid;
    gap: var(--size-4-4);
    min-height: 100%;
    padding: var(--size-4-4);
    background: var(--background-primary);
    color: var(--text-normal);
  }

  .toolbar,
  .filter-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--size-4-2);
  }

  .toolbar {
    padding-bottom: var(--size-4-3);
    border-bottom: 1px solid var(--border-color);
  }

  label,
  .filter-group {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  select,
  button {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
    color: var(--text-normal);
    font: inherit;
  }

  select {
    padding: var(--size-2-2) var(--size-4-2);
  }

  button {
    padding: var(--size-2-2) var(--size-4-2);
    cursor: pointer;
  }

  button.active {
    border-color: var(--interactive-accent);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .scope-summary {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .roadmap-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    gap: var(--size-4-4);
    min-width: 0;
  }

  .main-panel {
    min-width: 0;
  }

  @media (max-width: 700px) {
    .roadmap-layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
