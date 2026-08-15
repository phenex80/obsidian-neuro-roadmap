<script lang="ts">
  import { formatEntityLabel, formatNodeTitle, isNodeOverdue } from '../../core/TimelineDomain';
  import type { CalendarItemOverride, RoadmapNode } from '../../types';
  import CalendarActionButton from './CalendarActionButton.svelte';

  let {
    node,
    enableColorCoding,
    dateLabel,
    draggable = false,
    onDragStart,
    onToggleComplete,
    onOpenSource,
    onEdit,
    calendarOverride,
    calendarIncluded,
    calendarAvailable,
    onToggleCalendar,
  }: {
    node: RoadmapNode;
    enableColorCoding: boolean;
    dateLabel: string;
    draggable?: boolean;
    onDragStart?: (event: DragEvent, node: RoadmapNode) => void;
    onToggleComplete: (node: RoadmapNode, completed: boolean) => Promise<void>;
    onOpenSource: (node: RoadmapNode) => Promise<void>;
    onEdit: (node: RoadmapNode) => void;
    calendarOverride?: CalendarItemOverride;
    calendarIncluded: boolean;
    calendarAvailable: boolean;
    onToggleCalendar: (node: RoadmapNode) => Promise<void>;
  } = $props();
  let changing = $state(false);
  let overdue = $derived(isNodeOverdue(node));

  async function toggleCompletion(): Promise<void> {
    if (changing || node.source !== 'inline') return;
    changing = true;
    try {
      await onToggleComplete(node, !node.completed);
    } finally {
      changing = false;
    }
  }

</script>

<article
  class={`roadmap-task-card status-${node.status}`}
  class:color-coded={enableColorCoding}
  class:overdue
  class:draggable
  title={node.path}
  {draggable}
  ondragstart={(event) => onDragStart?.(event, node)}
>
  <div class="card-heading">
    {#if node.source === 'inline'}
      <button
        type="button"
        class="card-action checkbox-action"
        aria-label={`${node.completed ? 'Uncheck' : 'Complete'} ${formatNodeTitle(node)}`}
        aria-pressed={node.completed}
        disabled={changing}
        onclick={() => void toggleCompletion()}
      >{node.completed ? '☑' : '☐'}</button>
    {/if}
    <button
      type="button"
      class="source-title"
      title={`Open ${node.path}`}
      onclick={() => void onOpenSource(node)}
    >
      <strong>{formatNodeTitle(node)}</strong>
    </button>
    <button
      type="button"
      class="card-action note-action"
      title={`Quick note for ${formatNodeTitle(node)}`}
      aria-label={`Quick note for ${formatNodeTitle(node)}`}
      onclick={() => onEdit(node)}
    >✎</button>
    <CalendarActionButton
      itemLabel={formatNodeTitle(node)}
      included={calendarIncluded}
      override={calendarOverride}
      available={calendarAvailable}
      onToggle={() => onToggleCalendar(node)}
    />
  </div>

  <p class="context-line">
    <span>{formatEntityLabel(node.subject, 'Nezaradené')}</span>
    {#if node.project !== undefined}
      <span aria-hidden="true">·</span>
      <span>{formatEntityLabel(node.project, node.project)}</span>
    {/if}
  </p>

  <div class="metadata-row">
    <span class:warning-badge={overdue} class="date-badge">
      {overdue ? `⚠ ${dateLabel}` : dateLabel}
    </span>
    {#if node.status === 'in-progress'}
      <span class="status-badge">In progress</span>
    {/if}
    {#if node.priority === 'high'}
      <span class="priority-badge">High priority</span>
    {/if}
    {#if node.hardDependency}
      <span class="fixed-badge">◆ Fixed date</span>
    {/if}
  </div>
</article>

<style>
  .roadmap-task-card {
    display: flex;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    flex-direction: column;
    align-items: stretch;
    gap: var(--size-4-2);
    padding: var(--size-4-3);
    overflow: hidden;
    border: var(--border-width) solid var(--border-color);
    border-inline-start-width: calc(var(--border-width) * 2);
    border-radius: var(--radius-m);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    transition: border-color var(--anim-duration-fast) var(--anim-motion-swing);
  }

  .roadmap-task-card:hover,
  .roadmap-task-card:focus-within {
    border-color: var(--interactive-accent);
  }

  .roadmap-task-card.draggable {
    cursor: grab;
  }

  .roadmap-task-card.draggable:active {
    cursor: grabbing;
  }

  .roadmap-task-card.color-coded.status-todo {
    border-inline-start-color: var(--status-todo);
  }

  .roadmap-task-card.color-coded.status-in-progress {
    border-inline-start-color: var(--status-in-progress);
  }

  .roadmap-task-card.color-coded.status-done {
    border-inline-start-color: var(--status-done);
  }

  .roadmap-task-card.overdue {
    border-inline-start-color: var(--status-overdue);
    border-inline-start-style: double;
  }

  .card-heading {
    display: grid;
    grid-template-columns: min-content minmax(0, 1fr) min-content min-content;
    align-items: start;
    gap: var(--size-2-2);
  }

  .source-title,
  .card-action {
    border: 0;
    background: transparent;
    color: var(--text-normal);
    box-shadow: none;
  }

  .source-title {
    min-width: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }

  .source-title strong {
    display: -webkit-box;
    width: 100%;
    overflow: hidden;
    color: var(--text-normal);
    font-size: var(--font-ui-medium);
    line-height: var(--line-height-tight);
    white-space: normal;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .source-title:hover strong,
  .source-title:focus-visible strong {
    color: var(--interactive-accent);
  }

  .card-action {
    display: inline-grid;
    place-items: center;
    padding: var(--size-2-1);
    color: var(--text-muted);
    cursor: pointer;
  }

  .card-action:hover,
  .card-action:focus-visible {
    color: var(--interactive-accent);
  }

  .context-line {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: var(--size-2-1);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .metadata-row {
    display: flex;
    width: 100%;
    flex-wrap: wrap;
    gap: var(--size-2-2);
  }

  .metadata-row span {
    display: inline-flex;
    width: max-content;
    align-items: center;
    padding: var(--size-2-1) var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-l);
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .color-coded .status-badge {
    border-color: var(--status-in-progress);
    background: var(--status-in-progress);
    color: var(--text-on-accent);
  }

  .color-coded .priority-badge {
    border-color: var(--priority-high);
    background: var(--priority-high);
    color: var(--text-on-accent);
  }

  .metadata-row .warning-badge {
    border-color: var(--status-overdue);
    color: var(--text-error);
    font-weight: var(--font-semibold);
  }

  .fixed-badge {
    border-style: double !important;
  }
</style>
