import { dateStringSchema } from '../types';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Returns the inclusive number of calendar days covered by a scheduled node.
 * A task beginning and ending on the same day therefore occupies one day.
 */
export function calculateCalendarDaySpan(startDate: string, dueDate: string): number | null {
  const startTimestamp = toUtcTimestamp(startDate);
  const dueTimestamp = toUtcTimestamp(dueDate);

  if (startTimestamp === null || dueTimestamp === null || dueTimestamp < startTimestamp) {
    return null;
  }

  return (dueTimestamp - startTimestamp) / MILLISECONDS_PER_DAY + 1;
}

/**
 * Applies the planning-fallacy buffer to a node's inclusive calendar duration.
 */
export function calculateBufferedDuration(
  startDate: string,
  dueDate: string,
  bufferMultiplier: number,
): number | null {
  if (!Number.isFinite(bufferMultiplier) || bufferMultiplier <= 0) {
    return null;
  }

  const calendarDaySpan = calculateCalendarDaySpan(startDate, dueDate);
  return calendarDaySpan === null ? null : calendarDaySpan * bufferMultiplier;
}

function toUtcTimestamp(value: string): number | null {
  if (!dateStringSchema.safeParse(value).success) {
    return null;
  }

  const [yearValue, monthValue, dayValue] = value.split('-');
  return Date.UTC(Number(yearValue), Number(monthValue) - 1, Number(dayValue));
}
