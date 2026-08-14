import type { CalendarEventProjection } from './CalendarCore';
import type { CalendarItemOverride, CalendarSyncRecord } from '../types';

export interface CalendarProviderCapabilities {
  readonly export: boolean;
  readonly remoteCalendars: boolean;
  readonly create: boolean;
  readonly update: boolean;
  readonly delete: boolean;
  readonly reminders: boolean;
}

export interface CalendarConnectionStatus {
  readonly connected: boolean;
  readonly message?: string;
}

export interface CalendarDescriptor {
  readonly id: string;
  readonly name: string;
  readonly primary: boolean;
}

export interface ExternalCalendarEventRef {
  readonly calendarId: string;
  readonly eventId: string;
}

/** Provider boundary for future one-way sync implementations. */
export interface CalendarProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: CalendarProviderCapabilities;
  initialize(): Promise<CalendarConnectionStatus>;
  listCalendars(): Promise<readonly CalendarDescriptor[]>;
  exportEvents?(events: readonly CalendarEventProjection[]): string;
  createEvent?(calendarId: string, event: CalendarEventProjection): Promise<ExternalCalendarEventRef>;
  updateEvent?(reference: ExternalCalendarEventRef, event: CalendarEventProjection): Promise<void>;
  deleteEvent?(reference: ExternalCalendarEventRef): Promise<void>;
}

export interface CalendarSyncStateEntry extends CalendarSyncRecord {
  readonly override?: CalendarItemOverride;
}
