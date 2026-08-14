<script lang="ts">
  import { onMount } from 'svelte';
  import type { App } from 'obsidian';
  import type { RoadmapNode } from '../../types';
  import type { RoadmapIndexer } from '../../core/Indexer';
  import type { RoadmapScheduler } from '../../core/RoadmapScheduler';
  import { exportToICS } from '../../utils/icsExport';
  import DashboardView from '../components/DashboardView.svelte';
  import GanttCanvas from '../components/GanttCanvas.svelte';
  import HorizonBoard from '../components/HorizonBoard.svelte';
  import UnscheduledDrawer from '../components/UnscheduledDrawer.svelte';
  import ScratchpadPopover from '../components/ScratchpadPopover.svelte';
  import CircularDependencyAlert from '../components/CircularDependencyAlert.svelte';

  let {
    app,
    indexer,
    scheduler,
    enableColorCoding: initialEnableColorCoding,
    subscribeColorCoding,
  }: {
    app: App;
    indexer: RoadmapIndexer;
    scheduler: RoadmapScheduler;
    enableColorCoding: boolean;
    subscribeColorCoding: (listener: (enabled: boolean) => void) => () => void;
  } = $props();
  let nodes = $state<readonly RoadmapNode[]>([]);
  let enableColorCoding = $state(false);
  let semester = $state('all');
  let selectedSubjects = $state<string[]>([]);
  let priority = $state<'all' | 'high' | 'medium' | 'low'>('all');
  let viewMode = $state<'dashboard' | 'gantt' | 'horizon'>('dashboard');
  let scale = $state<'days' | 'weeks' | 'months'>('days');
  let scratchpadNode = $state<RoadmapNode | null>(null);
  let circularDependencyCycles = $state<readonly (readonly string[])[]>([]);
  const PRIORITY_FILTERS = ['all', 'high', 'medium', 'low'] as const;
  const TIMELINE_SCALES = ['days', 'weeks', 'months'] as const;

  let semesters = $derived(
    Array.from(
      new Set(
        nodes
          .map((node) => node.semester)
          .filter((value): value is string => value !== undefined),
      ),
    ).sort(),
  );
  let subjects = $derived(
    Array.from(
      new Set(
        nodes
          .map((node) => node.subject)
          .filter((value): value is string => value !== undefined),
      ),
    ).sort(),
  );
  let filteredNodes = $derived(
    nodes.filter(
      (node) =>
        (semester === 'all' || node.semester === semester) &&
        (selectedSubjects.length === 0 ||
          (node.subject !== undefined && selectedSubjects.includes(node.subject))) &&
        (priority === 'all' || node.priority === priority),
    ),
  );

  onMount(() => {
    enableColorCoding = initialEnableColorCoding;
    const unsubscribeIndexer = indexer.subscribe((updatedNodes) => {
      nodes = updatedNodes;
      circularDependencyCycles = indexer.getCircularDependencyCycles();
    });
    const unsubscribeColorCoding = subscribeColorCoding((enabled) => {
      enableColorCoding = enabled;
    });

    return () => {
      unsubscribeIndexer();
      unsubscribeColorCoding();
    };
  });

  function openScratchpad(node: RoadmapNode): void {
    scratchpadNode = node;
  }

  function formatSubject(subjectPath: string): string {
    const filename = subjectPath.split('/').at(-1) ?? subjectPath;
    return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  }

  function toggleSubject(subjectPath: string): void {
    selectedSubjects = selectedSubjects.includes(subjectPath)
      ? selectedSubjects.filter((subject) => subject !== subjectPath)
      : [...selectedSubjects, subjectPath];
  }

  async function appendScratchpad(text: string): Promise<void> {
    if (scratchpadNode !== null) {
      await scheduler.appendScratchpad(scratchpadNode, text);
    }
  }

  function downloadCalendar(): void {
    const calendar = exportToICS([...filteredNodes]);
    const blob = new Blob([calendar], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'roadmap-export.ics';
    anchor.hidden = true;
    document.body.appendChild(anchor);

    try {
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  }
</script>

<main class="roadmap-workspace">
  <header class="app-header">
    <label class="select-control">
      <span class="control-label">Semester</span>
      <select bind:value={semester} aria-label="Semester filter">
        <option value="all">All semesters</option>
        {#each semesters as availableSemester (availableSemester)}
          <option value={availableSemester}>{availableSemester}</option>
        {/each}
      </select>
    </label>

    <details class="subject-control">
      <summary>
        <span>Subjects</span>
        {#if selectedSubjects.length > 0}
          <span class="selection-badge">{selectedSubjects.length}</span>
        {/if}
      </summary>
      <div class="subject-menu">
        {#if subjects.length === 0}
          <span class="empty-option">No subjects indexed</span>
        {:else}
          {#each subjects as subjectPath (subjectPath)}
            <label title={subjectPath}>
              <input
                type="checkbox"
                checked={selectedSubjects.includes(subjectPath)}
                onchange={() => toggleSubject(subjectPath)}
              />
              <span>{formatSubject(subjectPath)}</span>
            </label>
          {/each}
        {/if}
      </div>
    </details>

    <div class="control-group">
      <span class="control-label">Priority</span>
      <div class="segmented-control" aria-label="Priority filter">
        {#each PRIORITY_FILTERS as level (level)}
          <button
            class:active={priority === level}
            aria-pressed={priority === level}
            onclick={() => (priority = level)}
          >
            {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
          </button>
        {/each}
      </div>
    </div>

    <div class="control-group">
      <span class="control-label">Scale</span>
      <div class="segmented-control" aria-label="Timeline scale">
        {#each TIMELINE_SCALES as timelineScale (timelineScale)}
          <button
            class:active={scale === timelineScale}
            aria-pressed={scale === timelineScale}
            onclick={() => (scale = timelineScale)}
          >
            {timelineScale.charAt(0).toUpperCase() + timelineScale.slice(1)}
          </button>
        {/each}
      </div>
    </div>

    <div class="control-group view-control">
      <span class="control-label">View</span>
      <div class="segmented-control" aria-label="Roadmap view mode">
        <button class:active={viewMode === 'dashboard'} aria-pressed={viewMode === 'dashboard'} onclick={() => (viewMode = 'dashboard')}>
          Dashboard
        </button>
        <button class:active={viewMode === 'gantt'} aria-pressed={viewMode === 'gantt'} onclick={() => (viewMode = 'gantt')}>
          Gantt
        </button>
        <button class:active={viewMode === 'horizon'} aria-pressed={viewMode === 'horizon'} onclick={() => (viewMode = 'horizon')}>
          Horizon
        </button>
      </div>
    </div>

    <button type="button" class="export-button" onclick={downloadCalendar}>Export (.ics)</button>

  </header>

  <div class="notice-slot">
    <CircularDependencyAlert cycles={circularDependencyCycles} />
  </div>

  <div class="roadmap-layout">
    <div class="main-panel">
      {#if viewMode === 'dashboard'}
        <DashboardView nodes={filteredNodes} />
      {:else if viewMode === 'gantt'}
        <GanttCanvas
          nodes={filteredNodes}
          {scale}
          {enableColorCoding}
          onReschedule={(node, startDate, dueDate) => scheduler.rescheduleNode(node, startDate, dueDate)}
          onSchedule={(node, startDate, dueDate) => scheduler.scheduleUnscheduledNode(node, startDate, dueDate)}
          onCreate={(startDate, dueDate) => scheduler.createNode(startDate, dueDate)}
          onEdit={openScratchpad}
        />
      {:else}
        <HorizonBoard nodes={filteredNodes} {enableColorCoding} onEdit={openScratchpad} />
      {/if}
    </div>
    <UnscheduledDrawer nodes={filteredNodes} {enableColorCoding} onEdit={openScratchpad} />
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
  :global(:root) {
    --status-todo: #579bfc;
    --status-in-progress: #fdab3d;
    --status-done: #00c875;
    --priority-high: #e2445c;
    --priority-medium: #fdab3d;
    --priority-low: #c4c4c4;
  }

  .roadmap-workspace {
    display: grid;
    align-content: start;
    gap: var(--size-4-3);
    min-height: 100%;
    background: var(--background-primary);
    color: var(--text-normal);
  }

  .app-header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--size-4-2);
    padding: var(--size-4-2) var(--size-4-3);
    border-bottom: var(--border-width) solid var(--border-color);
    background: var(--background-primary);
  }

  .select-control,
  .control-group {
    display: flex;
    align-items: center;
    gap: var(--size-2-2);
  }

  .control-label {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    font-weight: var(--font-medium);
  }

  select,
  .subject-control summary {
    min-height: var(--input-height);
    padding-inline: var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    font: inherit;
  }

  select {
    max-width: clamp(10rem, 16vw, 16rem);
  }

  .subject-control {
    position: relative;
  }

  .subject-control summary {
    display: flex;
    align-items: center;
    gap: var(--size-2-2);
    list-style: none;
    cursor: pointer;
  }

  .subject-control summary::-webkit-details-marker {
    display: none;
  }

  .selection-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--size-4-5);
    padding-inline: var(--size-2-1);
    border-radius: var(--radius-l);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    font-size: var(--font-ui-smaller);
  }

  .subject-menu {
    position: absolute;
    top: calc(100% + var(--size-2-2));
    left: 0;
    z-index: 30;
    display: grid;
    gap: var(--size-2-1);
    width: max-content;
    min-width: 100%;
    max-width: clamp(14rem, 32vw, 24rem);
    max-height: clamp(12rem, 45vh, 24rem);
    padding: var(--size-4-2);
    overflow: auto;
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary-alt);
    box-shadow: var(--shadow-s);
  }

  .subject-menu label {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    min-width: 0;
    padding: var(--size-2-2) var(--size-4-2);
    border-radius: var(--radius-s);
    color: var(--text-normal);
    cursor: pointer;
  }

  .subject-menu label:hover {
    background: var(--background-modifier-hover);
  }

  .subject-menu label span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subject-menu input {
    accent-color: var(--interactive-accent);
  }

  .empty-option {
    padding: var(--size-4-2);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .segmented-control {
    display: inline-flex;
    align-items: center;
    gap: var(--size-2-1);
    padding: var(--size-2-1);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-l);
    background: var(--background-secondary);
  }

  .segmented-control button {
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-l);
    font: inherit;
    cursor: pointer;
  }

  .segmented-control button {
    padding: var(--size-2-2) var(--size-4-2);
    background: var(--background-secondary);
    color: var(--text-muted);
  }

  .segmented-control button:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
  }

  .segmented-control button.active {
    border-color: var(--interactive-accent);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    box-shadow: var(--shadow-s);
  }

  .view-control {
    margin-inline-start: auto;
  }

  .export-button {
    padding: var(--size-2-2) var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }

  .export-button:hover,
  .export-button:focus-visible {
    border-color: var(--interactive-accent);
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .roadmap-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(14rem, min(22rem, 28%));
    gap: var(--size-4-3);
    min-width: 0;
    padding: 0 var(--size-4-3) var(--size-4-3);
  }

  .notice-slot {
    padding-inline: var(--size-4-3);
  }

  .main-panel {
    min-width: 0;
  }

  @media (max-width: 54rem) {
    .view-control {
      margin-inline-start: 0;
    }

    .roadmap-layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
