import type { CalendarItemOverride } from '../types';

export interface CalendarActionPresentation {
  readonly actionLabel: string;
  readonly iconName: string;
  readonly included: boolean;
  readonly manual: boolean;
  readonly available: boolean;
}

/** Shared accessible presentation for roadmap and editor calendar controls. */
export function describeCalendarAction(
  included: boolean,
  override: CalendarItemOverride | undefined,
  available: boolean,
): CalendarActionPresentation {
  if (!available) {
    return {
      actionLabel: 'Add a usable date before using Calendar.',
      iconName: 'calendar-off',
      included,
      manual: override !== undefined,
      available,
    };
  }
  if (override === 'exclude') {
    return {
      actionLabel: 'Excluded from calendar. Click to use automatic inclusion.',
      iconName: 'calendar-x',
      included,
      manual: true,
      available,
    };
  }
  if (override === 'include') {
    return {
      actionLabel: 'Included manually. Click to use automatic setting.',
      iconName: 'calendar-plus',
      included,
      manual: true,
      available,
    };
  }
  return {
    actionLabel: included
      ? 'Included automatically in calendar. Click to exclude.'
      : 'Not included by default. Click to add to calendar.',
    iconName: included ? 'calendar-check' : 'calendar-off',
    included,
    manual: false,
    available,
  };
}

export function calendarActionStateLabel(
  included: boolean,
  override: CalendarItemOverride | undefined,
  available: boolean,
): string {
  if (!available) return 'Unavailable until a date is set';
  if (override === 'exclude') return 'Excluded manually';
  if (override === 'include') return 'Included manually';
  return included ? 'Included automatically' : 'Not included automatically';
}
