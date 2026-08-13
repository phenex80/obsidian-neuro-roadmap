<script lang="ts">
  let { message }: { message: string } = $props();
</script>

<section class="codeblock-error" role="status" aria-label="Roadmap codeblock configuration error">
  <strong>Roadmap codeblock could not be rendered</strong>
  <p>{message}</p>
</section>

<style>
  .codeblock-error {
    padding: var(--size-4-3);
    border: 1px solid var(--color-orange);
    border-radius: var(--radius-m);
    background: var(--background-secondary);
    color: var(--text-normal);
  }

  strong {
    color: var(--color-orange);
  }

  p {
    margin: var(--size-2-2) 0 0;
    color: var(--text-muted);
  }
</style>
