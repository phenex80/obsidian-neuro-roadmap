<script lang="ts">
  let { cycles }: { cycles: readonly (readonly string[])[] } = $props();

  function describeCycle(cycle: readonly string[]): string {
    return cycle.map(getDisplayName).join(' → ');
  }

  function getDisplayName(nodeId: string): string {
    const blockSeparator = nodeId.indexOf('#');
    const path = blockSeparator === -1 ? nodeId : nodeId.slice(0, blockSeparator);
    const filename = path.split('/').at(-1) ?? path;
    return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  }
</script>

{#if cycles.length > 0}
  <section class="circular-dependency-alert" role="status" aria-label="Circular dependencies detected">
    <strong>Circular dependencies detected</strong>
    <p>Review the affected relationships before rescheduling nodes in these cycles.</p>
    <ul>
      {#each cycles as cycle, index (`${index}-${cycle.join('|')}`)}
        <li>{describeCycle(cycle)}</li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .circular-dependency-alert {
    padding: var(--size-4-3);
    border: 1px solid var(--color-orange);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
    color: var(--text-normal);
  }

  strong {
    color: var(--color-orange);
  }

  p,
  ul {
    margin: var(--size-2-2) 0 0;
  }

  p {
    color: var(--text-muted);
  }

  ul {
    padding-left: var(--size-4-5);
  }
</style>
