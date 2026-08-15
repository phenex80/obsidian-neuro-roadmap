<script lang="ts">
  import { setIcon } from 'obsidian';
  import { describeCalendarAction } from '../../core/CalendarAction';
  import type { CalendarItemOverride } from '../../types';

  let {
    itemLabel,
    included,
    override,
    available,
    onToggle,
  }: {
    itemLabel: string;
    included: boolean;
    override?: CalendarItemOverride;
    available: boolean;
    onToggle: () => void | Promise<void>;
  } = $props();

  let iconElement: HTMLSpanElement;
  let presentation = $derived(describeCalendarAction(included, override, available));

  $effect(() => {
    if (iconElement !== undefined) {
      iconElement.replaceChildren();
      setIcon(iconElement, presentation.iconName);
    }
  });
</script>

<button
  type="button"
  class="calendar-action-button"
  class:included
  class:excluded={!included}
  class:manual={override !== undefined}
  title={presentation.actionLabel}
  aria-label={`${presentation.actionLabel} ${itemLabel}`}
  aria-pressed={included}
  disabled={!available}
  onclick={() => void onToggle()}
>
  <span class="calendar-icon" bind:this={iconElement} aria-hidden="true"></span>
</button>

<style>
  .calendar-action-button {
    display: inline-grid;
    min-width: var(--clickable-icon-size);
    min-height: var(--clickable-icon-size);
    place-items: center;
    align-self: center;
    padding: var(--size-2-1);
    border: var(--border-width) solid var(--border-color);
    border-radius: var(--radius-s);
    background: var(--background-primary-alt);
    color: var(--text-muted);
    box-shadow: none;
    cursor: pointer;
  }

  .calendar-action-button:hover,
  .calendar-action-button:focus-visible,
  .calendar-action-button.included {
    border-color: var(--interactive-accent);
    color: var(--interactive-accent);
  }

  .calendar-action-button.included {
    background: var(--background-modifier-hover);
  }

  .calendar-action-button.excluded {
    color: var(--text-faint);
  }

  .calendar-action-button.manual {
    border-width: calc(var(--border-width) * 2);
  }

  .calendar-action-button:disabled {
    cursor: not-allowed;
    opacity: var(--icon-opacity);
  }

  .calendar-icon {
    display: inline-flex;
    width: var(--icon-size-s);
    height: var(--icon-size-s);
  }
</style>
