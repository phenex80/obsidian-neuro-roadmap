<script lang="ts">
  import type { RoadmapNode } from '../../types';

  interface SubjectProgress {
    subject: string;
    totalTasks: number;
    completedTasks: number;
    percent: number;
  }

  let { nodes }: { nodes: readonly RoadmapNode[] } = $props();
  let subjectProgress = $derived(aggregateBySubject(nodes));

  function aggregateBySubject(items: readonly RoadmapNode[]): SubjectProgress[] {
    const groups = new Map<string, { totalTasks: number; completedTasks: number }>();

    for (const node of items) {
      const subject = node.subject ?? 'Nezaradené';
      const progress = groups.get(subject) ?? { totalTasks: 0, completedTasks: 0 };
      progress.totalTasks += 1;
      if (node.status === 'done') {
        progress.completedTasks += 1;
      }
      groups.set(subject, progress);
    }

    return Array.from(groups.entries())
      .map(([subject, progress]) => ({
        subject,
        totalTasks: progress.totalTasks,
        completedTasks: progress.completedTasks,
        percent: Math.round((progress.completedTasks / progress.totalTasks) * 100),
      }))
      .sort((left, right) => formatSubject(left.subject).localeCompare(formatSubject(right.subject)));
  }

  function formatSubject(subject: string): string {
    if (subject === 'Nezaradené') {
      return subject;
    }

    const filename = subject.split('/').at(-1) ?? subject;
    return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  }
</script>

<section class="dashboard" aria-label="Academic progress dashboard">
  {#each subjectProgress as progress (progress.subject)}
    <article class="dashboard-card" title={progress.subject}>
      <header>
        <h2>{formatSubject(progress.subject)}</h2>
        <span>{progress.completedTasks}/{progress.totalTasks}</span>
      </header>
      <progress value={progress.percent} max="100">{progress.percent}%</progress>
      <p>{progress.percent}% complete</p>
    </article>
  {:else}
    <p class="empty-state">No roadmap nodes match the active filters.</p>
  {/each}
</section>

<style>
  .dashboard {
    display: grid !important;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)) !important;
    gap: 20px !important;
    padding: 20px !important;
    align-items: start !important;
  }

  .dashboard-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    border: var(--border-width) solid var(--border-color);
    border-radius: 8px;
    background: var(--background-secondary);
    color: var(--text-normal);
  }

  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--size-4-2);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    overflow: hidden;
    font-size: var(--font-ui-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  header span,
  p,
  .empty-state {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  progress {
    width: 100%;
    accent-color: var(--interactive-accent);
  }

  .empty-state {
    grid-column: 1 / -1;
    padding: var(--size-4-3);
  }
</style>
