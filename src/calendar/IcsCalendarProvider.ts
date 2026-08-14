import type { CalendarEventProjection } from '../core/CalendarCore';
import type {
  CalendarConnectionStatus,
  CalendarDescriptor,
  CalendarProvider,
  CalendarProviderCapabilities,
} from '../core/CalendarProvider';

const MAX_CONTENT_LINE_BYTES = 75;

export interface IcsCalendarProviderOptions {
  readonly now?: () => Date;
}

/** Stateless RFC 5545 file provider backed by Calendar Core projections. */
export class IcsCalendarProvider implements CalendarProvider {
  readonly id = 'ics';
  readonly displayName = 'iCalendar file';
  readonly capabilities: CalendarProviderCapabilities = {
    export: true,
    remoteCalendars: false,
    create: false,
    update: false,
    delete: false,
    reminders: true,
  };
  private readonly now: () => Date;

  constructor(options: IcsCalendarProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<CalendarConnectionStatus> {
    return { connected: true, message: 'No account connection is required for file export.' };
  }

  async listCalendars(): Promise<readonly CalendarDescriptor[]> {
    return [];
  }

  exportEvents(events: readonly CalendarEventProjection[]): string {
    const dtstamp = formatUtcTimestamp(this.now());
    const eventLines = [...events]
      .sort(
        (left, right) =>
          left.startDate.localeCompare(right.startDate) ||
          left.internalItemId.localeCompare(right.internalItemId),
      )
      .flatMap((event) => serializeEvent(event, dtstamp));
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Neuro Roadmap//Calendar Core 2.0//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      ...eventLines,
      'END:VCALENDAR',
    ];
    return `${lines.flatMap(foldContentLine).join('\r\n')}\r\n`;
  }
}

export function exportCalendarEventsToICS(
  events: readonly CalendarEventProjection[],
  options: IcsCalendarProviderOptions = {},
): string {
  return new IcsCalendarProvider(options).exportEvents(events);
}

function serializeEvent(event: CalendarEventProjection, dtstamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeText(`${event.internalItemId}@neuro-roadmap`)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${formatDate(event.startDate)}`,
    `DTEND;VALUE=DATE:${formatDate(event.endDateExclusive)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
  ];

  if (event.reminderMinutes !== null) {
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:${formatReminderTrigger(event.reminderMinutes)}`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(`Reminder: ${event.title}`)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

function formatDate(value: string): string {
  return value.replaceAll('-', '');
}

function formatUtcTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
}

function formatReminderTrigger(minutes: number): string {
  if (minutes === 0) {
    return '-PT0M';
  }
  const days = Math.floor(minutes / 1440);
  const remainingAfterDays = minutes % 1440;
  const hours = Math.floor(remainingAfterDays / 60);
  const remainingMinutes = remainingAfterDays % 60;
  const datePart = days > 0 ? `${days}D` : '';
  const timePart = [hours > 0 ? `${hours}H` : '', remainingMinutes > 0 ? `${remainingMinutes}M` : '']
    .join('');
  return `-P${datePart}${timePart.length > 0 ? `T${timePart}` : ''}`;
}

function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replace(/\r\n|\r|\n/gu, '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}

function foldContentLine(line: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let limit = MAX_CONTENT_LINE_BYTES;
  for (const character of line) {
    const candidate = `${current}${character}`;
    if (current.length > 0 && byteLength(candidate) > limit) {
      chunks.push(chunks.length === 0 ? current : ` ${current}`);
      current = character;
      limit = MAX_CONTENT_LINE_BYTES - 1;
    } else {
      current = candidate;
    }
  }
  chunks.push(chunks.length === 0 ? current : ` ${current}`);
  return chunks;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
