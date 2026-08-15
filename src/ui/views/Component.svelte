<script lang="ts">
  import { onMount } from 'svelte';
  import type { App } from 'obsidian';
  import {
    roadmapSettingsSchema,
    type CalendarItemOverride,
    type RoadmapNode,
    type RoadmapSettings,
  } from '../../types';
  import type { RoadmapIndexer } from '../../core/Indexer';
  import type { RoadmapScheduler } from '../../core/RoadmapScheduler';
  import type { CalendarExportResult } from '../../core/CalendarExportService';
  import type {
    CalendarSyncRuntimeStatus,
  } from '../../core/CalendarSyncController';
  import type { CalendarSyncReport } from '../../core/CalendarSyncEngine';
  import { TIMELINE_SCALES, type TimelineScale } from '../../core/TimelineDomain';
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
    initialSettings,
    subscribeSettings,
    persistGanttScale,
    getCalendarOverride,
    isCalendarIncluded,
    isCalendarAvailable,
    toggleCalendarOverride: requestToggleCalendarOverride,
    exportCalendar,
    calendarSyncProviderLabel,
    isCalendarSyncAvailable,
    getLastCalendarSyncAt,
    syncCalendar,
    subscribeCalendarSyncStatus,
  }: {
    app: App;
    indexer: RoadmapIndexer;
    scheduler: RoadmapScheduler;
    initialSettings: Readonly<RoadmapSettings>;
    subscribeSettings: (listener: (settings: Readonly<RoadmapSettings>) => void) => () => void;
    persistGanttScale: (scale: TimelineScale) => Promise<void>;
    getCalendarOverride: (node: RoadmapNode) => CalendarItemOverride | undefined;
    isCalendarIncluded: (node: RoadmapNode) => boolean;
    isCalendarAvailable: (node: RoadmapNode) => boolean;
    toggleCalendarOverride: (node: RoadmapNode) => Promise<void>;
    exportCalendar: (nodes: readonly RoadmapNode[]) => Promise<CalendarExportResult>;
    calendarSyncProviderLabel: string;
    isCalendarSyncAvailable: () => boolean;
    getLastCalendarSyncAt: () => string | undefined;
    syncCalendar: () => Promise<CalendarSyncReport>;
    subscribeCalendarSyncStatus: (listener: (status: CalendarSyncRuntimeStatus) => void) => () => void;
  } = $props();
  let nodes = $state<readonly RoadmapNode[]>([]);
  let settings = $state<RoadmapSettings>(roadmapSettingsSchema.parse({}));
  let enableColorCoding = $derived(settings.enableColorCoding);
  let semester = $state('all');
  let selectedSubjects = $state<string[]>([]);
  let priority = $state<'all' | 'high' | 'medium' | 'low'>('all');
  let viewMode = $state<'dashboard' | 'gantt' | 'horizon'>('dashboard');
  let scale = $state<TimelineScale>('fit');
  let scratchpadNode = $state<RoadmapNode | null>(null);
  let circularDependencyCycles = $state<readonly (readonly string[])[]>([]);
  let exportingCalendar = $state(false);
  let calendarSyncStatus = $state<CalendarSyncRuntimeStatus>({ phase: 'idle' });
  const PRIORITY_FILTERS = ['all', 'high', 'medium', 'low'] as const;

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
    settings = cloneSettings(initialSettings);
    scale = initialSettings.ganttScale;
    const unsubscribeIndexer = indexer.subscribe((updatedNodes) => {
      nodes = updatedNodes;
      circularDependencyCycles = indexer.getCircularDependencyCycles();
    });
    const unsubscribeSettings = subscribeSettings((updatedSettings) => {
      settings = cloneSettings(updatedSettings);
      scale = updatedSettings.ganttScale;
    });
    const unsubscribeCalendarSync = subscribeCalendarSyncStatus((status) => {
      calendarSyncStatus = status;
    });

    return () => {
      unsubscribeIndexer();
      unsubscribeSettings();
      unsubscribeCalendarSync();
    };
  });

  function openScratchpad(node: RoadmapNode): void {
    scratchpadNode = node;
  }

  async function selectScale(nextScale: TimelineScale): Promise<void> {
    scale = nextScale;
    await persistGanttScale(nextScale);
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

  function calendarOverride(node: RoadmapNode): CalendarItemOverride | undefined {
    return getCalendarOverride(node);
  }

  function calendarIncluded(node: RoadmapNode): boolean {
    return isCalendarIncluded(node);
  }

  function calendarAvailable(node: RoadmapNode): boolean {
    return isCalendarAvailable(node);
  }

  async function toggleCalendarOverride(node: RoadmapNode): Promise<void> {
    await requestToggleCalendarOverride(node);
  }

  async function downloadCalendar(scope: 'current' | 'all'): Promise<void> {
    if (exportingCalendar) return;
    exportingCalendar = true;
    let result: CalendarExportResult;
    try {
      result = await exportCalendar(scope === 'current' ? filteredNodes : nodes);
    } finally {
      exportingCalendar = false;
    }
    const blob = new Blob([result.content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = scope === 'current' ? 'roadmap-current-view.ics' : 'roadmap-all-eligible.ics';
    anchor.hidden = true;
    document.body.appendChild(anchor);

    try {
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  }

  async function runCalendarSync(): Promise<void> {
    try {
      await syncCalendar();
    } catch {
      // CalendarSyncController publishes and persists the actionable error.
    }
  }

  function calendarSyncLabel(): string {
    if (calendarSyncStatus.phase === 'syncing') return 'Syncing…';
    if (calendarSyncStatus.phase === 'scheduled') return 'Waiting to sync…';
    if (calendarSyncStatus.phase === 'error') {
      return calendarSyncStatus.message === undefined
        ? 'Sync error'
        : `Sync error: ${calendarSyncStatus.message}`;
    }
    const lastSyncAt = getLastCalendarSyncAt();
    if (lastSyncAt === undefined) return 'Waiting for first synchronization';
    const timestamp = new Date(lastSyncAt);
    return Number.isNaN(timestamp.getTime())
      ? `Last sync: ${lastSyncAt}`
      : `Up to date · ${timestamp.toLocaleString()}`;
  }

  function cloneSettings(value: Readonly<RoadmapSettings>): RoadmapSettings {
    return roadmapSettingsSchema.parse(value);
  }
</script>

<main
  class="roadmap-workspace"
  style={`--status-todo: ${settings.colors.todo}; --status-in-progress: ${settings.colors.inProgress}; --status-done: ${settings.colors.done}; --status-overdue: ${settings.colors.overdue}; --priority-high: ${settings.colors.priorityHigh}; --priority-medium: ${settings.colors.priorityMedium}; --priority-low: ${settings.colors.priorityLow}`}
>
  <header class="app-header">
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
            onclick={() => void selectScale(timelineScale)}
          >
            {timelineScale.charAt(0).toUpperCase() + timelineScale.slice(1)}
          </button>
        {/each}
      </div>
    </div>

    <details class="calendar-control">
      <summary>Calendar</summary>
      <div class="calendar-menu">
        {#if isCalendarSyncAvailable()}
          <button
            type="button"
            disabled={calendarSyncStatus.phase === 'syncing'}
            onclick={() => void runCalendarSync()}
          >Sync {calendarSyncProviderLabel} now</button>
          <span class:error-state={calendarSyncStatus.phase === 'error'}>{calendarSyncLabel()}</span>
        {/if}
        <button type="button" disabled={exportingCalendar} onclick={() => void downloadCalendar('current')}>
          Export current view (.ics)
        </button>
        <button type="button" disabled={exportingCalendar} onclick={() => void downloadCalendar('all')}>
          Export all eligible items (.ics)
        </button>
        <span>Policy and reminders are configured in Neuro Roadmap settings.</span>
      </div>
    </details>

  </header>

  <div class="notice-slot">
    <CircularDependencyAlert cycles={circularDependencyCycles} />
  </div>

  <div class="roadmap-layout">
    <div class="main-panel">
      {#if viewMode === 'dashboard'}
        <DashboardView nodes={filteredNodes} {enableColorCoding} />
      {:else if viewMode === 'gantt'}
        <GanttCanvas
          nodes={filteredNodes}
          {scale}
          {enableColorCoding}
          onReschedule={(node, startDate, dueDate) => scheduler.rescheduleNode(node, startDate, dueDate)}
          onSchedule={(node, startDate, dueDate) => scheduler.scheduleUnscheduledNode(node, startDate, dueDate)}
          onCreate={(startDate, dueDate) => scheduler.createNode(startDate, dueDate)}
          onEdit={openScratchpad}
          onToggleComplete={(node, completed) => scheduler.setTaskCompletion(node, completed).then(() => undefined)}
          onOpenSource={(node) => scheduler.openSource(node)}
          getCalendarOverride={calendarOverride}
          isCalendarIncluded={calendarIncluded}
          isCalendarAvailable={calendarAvailable}
          onToggleCalendar={toggleCalendarOverride}
        />
      {:else}
        <HorizonBoard
          nodes={filteredNodes}
          {enableColorCoding}
          nextDays={settings.horizonNextDays}
          criticalDays={settings.horizonCriticalDays}
          overduePreviewLimit={settings.horizonOverduePreviewLimit}
          onEdit={openScratchpad}
          onToggleComplete={(node, completed) => scheduler.setTaskCompletion(node, completed).then(() => undefined)}
          onOpenSource={(node) => scheduler.openSource(node)}
          getCalendarOverride={calendarOverride}
          isCalendarIncluded={calendarIncluded}
          isCalendarAvailable={calendarAvailable}
          onToggleCalendar={toggleCalendarOverride}
        />
      {/if}
    </div>
    <UnscheduledDrawer
      nodes={filteredNodes}
      {enableColorCoding}
      onEdit={openScratchpad}
      onToggleComplete={(node, completed) => scheduler.setTaskCompletion(node, completed).then(() => undefined)}
      onOpenSource={(node) => scheduler.openSource(node)}
      getCalendarOverride={calendarOverride}
      isCalendarIncluded={calendarIncluded}
      isCalendarAvailable={calendarAvailable}
      onToggleCalendar={toggleCalendarOverride}
    />
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
    justify-content: flex-start !important;
    gap: var(--size-4-3);
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

  .calendar-control {
    position: relative;
  }

  .calendar-control summary {
    min-height: var(--input-height);
    padding-inline: var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    line-height: var(--input-height);
    list-style: none;
    cursor: pointer;
  }

  .calendar-control summary::-webkit-details-marker {
    display: none;
  }

  .calendar-menu {
    position: absolute;
    top: calc(100% + var(--size-2-2));
    right: 0;
    z-index: 30;
    display: grid;
    width: max-content;
    max-width: min(24rem, 85vw);
    gap: var(--size-2-2);
    padding: var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-primary);
    box-shadow: var(--shadow-l);
  }

  .calendar-menu button {
    justify-content: flex-start;
    text-align: left;
  }

  .calendar-menu span {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .calendar-menu .error-state {
    color: var(--text-error);
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
    margin-inline-start: 0;
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
