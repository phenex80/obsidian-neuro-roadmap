<script lang="ts">
  import { Component, MarkdownRenderer, type App } from 'obsidian';
  import { onMount } from 'svelte';
  import type { RoadmapNode } from '../../types';

  let {
    app,
    node,
    onSave,
    onClose,
  }: {
    app: App;
    node: RoadmapNode;
    onSave: (text: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let draft = $state('');
  let saving = $state(false);
  let previewEl = $state<HTMLDivElement>();
  const renderer = new Component();

  onMount(() => {
    renderer.load();
    return () => renderer.unload();
  });

  $effect(() => {
    if (previewEl === undefined) {
      return;
    }

    previewEl.replaceChildren();
    if (draft.trim().length > 0) {
      void MarkdownRenderer.render(app, draft, previewEl, node.path, renderer);
    }
  });

  async function save(): Promise<void> {
    if (saving || draft.trim().length === 0) {
      return;
    }

    saving = true;
    try {
      await onSave(draft);
      onClose();
    } finally {
      saving = false;
    }
  }
</script>

<div class="popover-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
  <dialog
    open
    class="scratchpad-popover"
    aria-label={`Quick note for ${node.title}`}
  >
    <header>
      <div>
        <p>Quick note</p>
        <h3>{node.title}</h3>
      </div>
      <button aria-label="Close quick note" onclick={onClose}>Close</button>
    </header>
    <label>
      <span>Append Markdown to this note</span>
      <textarea bind:value={draft} placeholder="Write a thought, next step, or reference…"></textarea>
    </label>
    <section class="preview-section" aria-label="Markdown preview">
      <p>Preview</p>
      <div class="markdown-preview-view" bind:this={previewEl}></div>
    </section>
    <footer>
      <button onclick={onClose}>Cancel</button>
      <button class="save-button" disabled={saving || draft.trim().length === 0} onclick={() => void save()}>
        {saving ? 'Saving…' : 'Append to note'}
      </button>
    </footer>
  </dialog>
</div>

<style>
  .popover-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--layer-modal);
    display: grid;
    place-items: center;
    padding: var(--size-4-4);
    background: var(--background-modifier-cover);
  }

  .scratchpad-popover {
    display: grid;
    gap: var(--size-4-3);
    width: min(42rem, 100%);
    max-height: min(42rem, 100%);
    padding: var(--size-4-4);
    overflow: auto;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-l);
    background: var(--background-primary);
    color: var(--text-normal);
  }

  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-2);
  }

  p,
  h3 {
    margin: 0;
  }

  p,
  label span {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  h3 {
    color: var(--text-normal);
  }

  label {
    display: grid;
    gap: var(--size-2-2);
  }

  textarea {
    min-height: 9rem;
    padding: var(--size-4-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-s);
    resize: vertical;
    background: var(--background-secondary);
    color: var(--text-normal);
    font: inherit;
  }

  .preview-section {
    display: grid;
    gap: var(--size-2-2);
  }

  .markdown-preview-view {
    min-height: var(--size-4-6);
    padding: var(--size-4-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
  }

  button {
    padding: var(--size-2-2) var(--size-4-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
    color: var(--text-normal);
    font: inherit;
    cursor: pointer;
  }

  .save-button {
    border-color: var(--interactive-accent);
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  button:disabled {
    opacity: var(--dimmed);
    cursor: not-allowed;
  }
</style>
