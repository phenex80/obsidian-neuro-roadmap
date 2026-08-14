<script lang="ts">
  import type { RoadmapNode } from '../../types';

  interface SubjectProgress {
    subject: string;
    totalTasks: number;
    completedTasks: number;
    percent: number;
    startDate?: string;
    dueDate?: string;
    currentDayProgress: number;
    subjectTasks: readonly MilestoneTask[];
  }

  interface MilestoneTask {
    id: string;
    title: string;
    dueDate: string;
    position: number;
    status: 'done' | 'todo' | 'overdue';
  }

  let { nodes }: { nodes: readonly RoadmapNode[] } = $props();
  let subjectProgress = $derived(aggregateBySubject(nodes));

  function aggregateBySubject(items: readonly RoadmapNode[]): SubjectProgress[] {
    const groups = new Map<string, RoadmapNode[]>();

    for (const node of items) {
      const subject = node.subject ?? 'Nezaradené';
      const subjectNodes = groups.get(subject) ?? [];
      subjectNodes.push(node);
      groups.set(subject, subjectNodes);
    }

    return Array.from(groups.entries())
      .map(([subject, subjectNodes]) => createSubjectProgress(subject, subjectNodes))
      .sort((left, right) => formatSubject(left.subject).localeCompare(formatSubject(right.subject)));
  }

  function createSubjectProgress(subject: string, subjectNodes: readonly RoadmapNode[]): SubjectProgress {
    const completedTasks = subjectNodes.filter((node) => node.status === 'done').length;
    const datedNodes = subjectNodes
      .map((node) => ({ node, taskDate: validDate(node.dueDate ?? node.startDate) }))
      .filter((entry): entry is { node: RoadmapNode; taskDate: string } => entry.taskDate !== null);
    const startDates = subjectNodes
      .map((node) => validDate(node.startDate ?? node.dueDate))
      .filter((date): date is string => date !== null)
      .sort();
    const dueDates = subjectNodes
      .map((node) => validDate(node.dueDate ?? node.startDate))
      .filter((date): date is string => date !== null)
      .sort();
    const startDate = startDates[0];
    const dueDate = dueDates.at(-1);
    const startTimestamp = startDate === undefined ? null : toTimestamp(startDate);
    const dueTimestamp = dueDate === undefined ? null : toTimestamp(dueDate);
    const currentTimestamp = todayTimestamp();
    const subjectTasks =
      startTimestamp === null || dueTimestamp === null
        ? []
        : datedNodes
            .map(({ node, taskDate }) => {
              const taskTimestamp = toTimestamp(taskDate);
              return {
                id: node.id,
                title: displayTitle(node),
                dueDate: taskDate,
                position: calculateTaskPosition(taskTimestamp, startTimestamp, dueTimestamp),
                status: milestoneStatus(node, taskTimestamp, currentTimestamp),
              } satisfies MilestoneTask;
            })
            .sort((left, right) => left.position - right.position);

    return {
      subject,
      totalTasks: subjectNodes.length,
      completedTasks,
      percent: Math.round((completedTasks / subjectNodes.length) * 100),
      startDate,
      dueDate,
      currentDayProgress:
        startTimestamp === null || dueTimestamp === null
          ? 0
          : calculateCurrentDayProgress(currentTimestamp, startTimestamp, dueTimestamp),
      subjectTasks,
    };
  }

  function validDate(value: string | undefined): string | null {
    if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
      return null;
    }

    const timestamp = toTimestamp(value);
    return Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value
      ? null
      : value;
  }

  function toTimestamp(value: string): number {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  }

  function todayTimestamp(): number {
    const now = new Date();
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function calculateTaskPosition(taskDate: number, startDate: number, dueDate: number): number {
    if (dueDate === startDate) {
      return 50;
    }
    return clamp(((taskDate - startDate) / (dueDate - startDate)) * 100);
  }

  function calculateCurrentDayProgress(currentDate: number, startDate: number, dueDate: number): number {
    if (dueDate === startDate) {
      return currentDate < startDate ? 0 : 100;
    }
    return clamp(((currentDate - startDate) / (dueDate - startDate)) * 100);
  }

  function clamp(value: number): number {
    return Math.min(100, Math.max(0, value));
  }

  function milestoneStatus(
    node: RoadmapNode,
    taskDate: number,
    currentDate: number,
  ): MilestoneTask['status'] {
    if (node.status === 'done') {
      return 'done';
    }
    return taskDate < currentDate ? 'overdue' : 'todo';
  }

  function displayTitle(node: RoadmapNode): string {
    if (node.title.trim().length > 0) {
      return node.title;
    }

    const filename = node.path.split('/').at(-1) ?? '';
    const basename = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
    return basename.length > 0 ? basename : 'Neznáma úloha';
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
      <div class="milestone-track-container">
        <div class="milestone-track-line">
          <div
            class="milestone-progress-fill"
            style={`width: ${progress.currentDayProgress}%`}
          ></div>
          {#each progress.subjectTasks as task (task.id)}
            <div
              class={`milestone-dot status-${task.status}`}
              style={`left: ${task.position}%`}
              title={`${task.title} (${task.dueDate})`}
            ></div>
          {/each}
        </div>
      </div>
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

  .milestone-track-container {
    width: 100%;
  }

  .milestone-track-line {
    position: relative;
    width: 100%;
    height: 6px;
    margin: 16px 0;
    border-radius: 3px;
    background: var(--background-modifier-border);
  }

  .milestone-progress-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    border-radius: 3px;
    background: var(--interactive-accent);
    opacity: 0.5;
  }

  .milestone-dot {
    position: absolute;
    top: 50%;
    z-index: 2;
    width: 12px;
    height: 12px;
    transform: translate(-50%, -50%);
    border: 2px solid var(--background-secondary);
    border-radius: 50%;
  }

  .milestone-dot.status-done {
    background: #00c875;
  }

  .milestone-dot.status-todo {
    background: #579bfc;
  }

  .milestone-dot.status-overdue {
    background: #ff3b30;
  }

  .empty-state {
    grid-column: 1 / -1;
    padding: var(--size-4-3);
  }
</style>
