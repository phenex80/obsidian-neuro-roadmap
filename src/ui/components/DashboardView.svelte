<script lang="ts">
  import {
    formatEntityLabel,
    formatNodeTitle,
    isNodeOverdue,
    todayDate,
    type TimelineOverviewItem,
  } from '../../core/TimelineDomain';
  import { buildSubjectSummaries } from '../../core/DashboardMetrics';
  import type { RoadmapNode } from '../../types';

  let {
    nodes,
    enableColorCoding,
  }: {
    nodes: readonly RoadmapNode[];
    enableColorCoding: boolean;
  } = $props();
  let subjectSummaries = $derived(buildSubjectSummaries(nodes));

  function overviewTooltip(item: TimelineOverviewItem): string {
    if (item.kind === 'cluster') {
      return `${item.nodes.length} items: ${item.nodes.slice(0, 3).map(formatNodeTitle).join(', ')}${item.nodes.length > 3 ? '…' : ''}`;
    }
    const node = item.nodes[0];
    if (node === undefined) return '';
    const date = node.startDate !== undefined && node.dueDate !== undefined
      ? `${node.startDate} → ${node.dueDate}`
      : node.dueDate ?? node.startDate ?? '';
    return `${formatNodeTitle(node)} · ${date}${isNodeOverdue(node) ? ' · Overdue' : ''}`;
  }
</script>

<section class="dashboard" aria-label="Academic progress dashboard">
  {#each subjectSummaries as summary (summary.subject)}
    <article class="dashboard-card" title={summary.subject}>
      <header class="card-header">
        <h2>{formatEntityLabel(summary.subject, 'Nezaradené')}</h2>
        <span class="completion-count">{summary.completedTasks}/{summary.totalTasks}</span>
      </header>

      <div class="completion-summary">
        <strong>{summary.completionPercent}%</strong>
        <span>Task completion</span>
      </div>

      <div class="mini-timeline" aria-label={`Timeline for ${formatEntityLabel(summary.subject, 'Nezaradené')}`}>
        <div class="mini-track" aria-hidden="true"></div>
        {#each summary.overview as item (item.key)}
          <span
            class={`mini-item mini-${item.kind} status-${item.status}`}
            class:color-coded={enableColorCoding}
            class:overdue={item.overdue}
            style={`--mini-left: ${item.leftPercent}%; --mini-width: ${item.widthPercent}%`}
            title={overviewTooltip(item)}
          >
            {#if item.kind === 'cluster'}+{item.nodes.length}{/if}
          </span>
        {/each}
        {#if summary.todayPosition !== null}
          <span
            class="mini-today"
            style={`--mini-today: ${summary.todayPosition}%`}
            title={`Today · ${todayDate()}`}
          ></span>
        {/if}
      </div>

      <dl class="subject-facts">
        <div>
          <dt>Next deadline</dt>
          <dd title={summary.nextDeadline?.path}>
            {#if summary.nextDeadline === undefined}
              None scheduled
            {:else}
              <strong>{summary.nextDeadline.dueDate}</strong>
              <span>{formatNodeTitle(summary.nextDeadline)}</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt>Overdue</dt>
          <dd class:has-overdue={summary.overdueCount > 0}>
            <strong>{summary.overdueCount}</strong>
            <span>{summary.overdueCount === 1 ? 'task' : 'tasks'}</span>
          </dd>
        </div>
      </dl>
    </article>
  {:else}
    <p class="empty-state">No task-bearing subjects match the active filters.</p>
  {/each}
</section>

<style>
  .dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr));
    align-items: start;
    gap: var(--size-4-4);
    padding: var(--size-4-4);
  }

  .dashboard-card {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--size-4-3);
    padding: var(--size-4-4);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
    color: var(--text-normal);
  }

  .card-header,
  .completion-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-2);
  }

  h2,
  dl,
  dt,
  dd,
  p {
    margin: 0;
  }

  h2 {
    min-width: 0;
    overflow: hidden;
    font-size: var(--font-ui-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .completion-count {
    flex: 0 0 auto;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .completion-summary strong {
    font-size: var(--font-ui-large);
  }

  .completion-summary span,
  dt,
  .empty-state {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .mini-timeline {
    position: relative;
    height: var(--size-4-6);
    overflow: hidden;
  }

  .mini-track {
    position: absolute;
    inset: 50% 0 auto;
    height: var(--border-width);
    background: var(--background-modifier-border);
  }

  .mini-item {
    position: absolute;
    top: 50%;
    left: var(--mini-left);
    z-index: 2;
    display: grid;
    min-width: var(--size-4-2);
    height: var(--size-4-2);
    place-items: center;
    transform: translate(-50%, -50%);
    border: var(--border-width) solid var(--text-muted);
    border-radius: var(--radius-l);
    background: var(--background-primary-alt);
    color: var(--text-normal);
    font-size: var(--font-ui-smaller);
  }

  .mini-segment {
    width: max(var(--mini-width), var(--size-4-2));
    transform: translateY(-50%);
  }

  .mini-marker {
    transform: translate(-50%, -50%) rotate(45deg);
    border-radius: var(--radius-s);
  }

  .mini-cluster {
    width: var(--size-4-6);
    height: var(--size-4-6);
  }

  .mini-item.color-coded.status-todo {
    background: var(--status-todo);
    color: var(--text-on-accent);
  }

  .mini-item.color-coded.status-in-progress {
    background: var(--status-in-progress);
    color: var(--text-on-accent);
  }

  .mini-item.color-coded.status-done {
    background: var(--status-done);
    color: var(--text-on-accent);
  }

  .mini-item.overdue {
    outline: var(--border-width) solid var(--status-overdue);
    outline-offset: var(--border-width);
  }

  .mini-today {
    position: absolute;
    inset: 0 auto 0 var(--mini-today);
    z-index: 3;
    width: calc(var(--border-width) * 2);
    transform: translateX(-50%);
    background: var(--interactive-accent);
    pointer-events: none;
  }

  .subject-facts {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(min-content, 1fr);
    gap: var(--size-4-3);
  }

  .subject-facts > div {
    display: grid;
    align-content: start;
    gap: var(--size-2-1);
    min-width: 0;
    padding: var(--size-4-2);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-primary-alt);
  }

  dd {
    display: grid;
    min-width: 0;
    gap: var(--size-2-1);
  }

  dd span {
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  dd.has-overdue strong {
    color: var(--text-error);
  }

  .empty-state {
    grid-column: 1 / -1;
    padding: var(--size-4-3);
  }

  @media (max-width: 40rem) {
    .dashboard {
      padding: var(--size-4-2);
    }

    .subject-facts {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
