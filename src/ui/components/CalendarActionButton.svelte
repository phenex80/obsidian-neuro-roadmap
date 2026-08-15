<script lang="ts">
  import { setIcon } from 'obsidian';
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
  let actionLabel = $derived.by(() => {
    if (!available) return 'Add a usable date before using Calendar.';
    if (override === 'exclude') {
      return 'Excluded from calendar. Click to use automatic inclusion.';
    }
    if (override === 'include') {
      return 'Included manually. Click to use automatic setting.';
    }
    return included
      ? 'Included automatically in calendar. Click to exclude.'
      : 'Not included by default. Click to add to calendar.';
  });
  let iconName = $derived.by(() => {
    if (!available) return 'calendar-off';
    if (override === 'exclude') return 'calendar-x';
    if (override === 'include') return 'calendar-plus';
    return included ? 'calendar-check' : 'calendar-off';
  });

  $effect(() => {
    if (iconElement !== undefined) {
      iconElement.replaceChildren();
      setIcon(iconElement, iconName);
    }
  });
</script>

<button
  type="button"
  class="calendar-action-button"
  class:included
  class:excluded={!included}
  class:manual={override !== undefined}
  title={actionLabel}
  aria-label={`${actionLabel} ${itemLabel}`}
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
