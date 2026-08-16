import type { CalendarEventProjection } from '../core/CalendarCore';
import type {
  CalendarConnectionStatus,
  CalendarDescriptor,
  CalendarProvider,
  CalendarProviderCapabilities,
  ExternalCalendarEventRef,
} from '../core/CalendarProvider';
import type {
  CalendarHttpRequest,
  CalendarHttpResponse,
  CalendarHttpTransport,
} from './CalendarHttpTransport';
import type { GoogleAuthConfiguration } from './GoogleAuth';

const GOOGLE_CALENDAR_ROOT = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';
const MAX_RETRY_ATTEMPTS = 2;

export interface GoogleAccessTokenProvider {
  getAccessToken(configuration: GoogleAuthConfiguration): Promise<string>;
  invalidateAccessToken(): void;
}

export interface GoogleAccountProfile {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export type GoogleCalendarErrorKind =
  | 'authentication'
  | 'permission'
  | 'not-found'
  | 'throttled'
  | 'server'
  | 'network'
  | 'invalid-response';

export class GoogleCalendarError extends Error {
  constructor(
    readonly kind: GoogleCalendarErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
}

interface GoogleEventPayload {
  readonly id?: string;
  readonly summary: string;
  readonly description: string;
  readonly start: { readonly date: string };
  readonly end: { readonly date: string };
  readonly transparency: 'transparent';
  readonly visibility: 'default';
  readonly reminders: {
    readonly useDefault: false;
    readonly overrides?: readonly {
      readonly method: 'popup';
      readonly minutes: number;
    }[];
  };
  readonly extendedProperties: {
    readonly private: { readonly neuroRoadmapItemId: string };
  };
}

/** Google Calendar API implementation; Calendar Core remains provider-neutral and authoritative. */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = 'google';
  readonly displayName = 'Google Calendar';
  readonly capabilities: CalendarProviderCapabilities = {
    export: false,
    remoteCalendars: true,
    create: true,
    update: true,
    delete: true,
    reminders: true,
  };

  constructor(
    private readonly configuration: () => GoogleAuthConfiguration,
    private readonly tokens: GoogleAccessTokenProvider,
    private readonly transport: CalendarHttpTransport,
    private readonly wait: (milliseconds: number) => Promise<void> = waitFor,
    private readonly random: () => number = Math.random,
  ) {}

  async initialize(): Promise<CalendarConnectionStatus> {
    try {
      const profile = await this.getAccountProfile();
      return { connected: true, message: profile.email };
    } catch (error) {
      return {
        connected: false,
        message: error instanceof Error ? error.message : 'Google Calendar connection failed.',
      };
    }
  }

  async getAccountProfile(): Promise<GoogleAccountProfile> {
    const response = await this.googleRequest('GET', GOOGLE_USERINFO_ENDPOINT);
    const record = objectValue(response.json);
    const id = stringValue(record['sub']);
    const email = stringValue(record['email']);
    const displayName = stringValue(record['name']) ?? email;
    if (id === null || email === null || displayName === null) {
      throw new GoogleCalendarError('invalid-response', 'Google returned an invalid account profile.');
    }
    return { id, displayName, email };
  }

  async listCalendars(): Promise<readonly CalendarDescriptor[]> {
    const calendars: CalendarDescriptor[] = [];
    let pageToken: string | null = null;
    do {
      const parameters = new URLSearchParams({ maxResults: '250', minAccessRole: 'writer' });
      if (pageToken !== null) parameters.set('pageToken', pageToken);
      const response = await this.googleRequest(
        'GET',
        `${GOOGLE_CALENDAR_ROOT}/users/me/calendarList?${parameters.toString()}`,
      );
      const record = objectValue(response.json);
      const items = Array.isArray(record['items']) ? record['items'] : [];
      for (const item of items) {
        const calendar = parseCalendar(item);
        if (calendar !== null) calendars.push(calendar);
      }
      pageToken = stringValue(record['nextPageToken']);
    } while (pageToken !== null);

    return calendars.sort(
      (left, right) => Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name),
    );
  }

  async createCalendar(name: string): Promise<CalendarDescriptor> {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new GoogleCalendarError('invalid-response', 'Calendar name cannot be empty.');
    }
    const response = await this.googleRequest('POST', `${GOOGLE_CALENDAR_ROOT}/calendars`, {
      summary: trimmedName,
      description: 'One-way calendar projection managed by Neuro Roadmap.',
    });
    const calendar = parseCalendar(response.json);
    if (calendar === null) {
      throw new GoogleCalendarError('invalid-response', 'Google returned an invalid calendar.');
    }
    return calendar;
  }

  async createEvent(
    calendarId: string,
    event: CalendarEventProjection,
  ): Promise<ExternalCalendarEventRef> {
    const eventId = await googleEventId(event.internalItemId);
    try {
      const response = await this.googleRequest(
        'POST',
        calendarEventsPath(calendarId),
        toGoogleCalendarEvent(event, eventId),
      );
      const returnedId = stringValue(objectValue(response.json)['id']);
      if (returnedId === null) {
        throw new GoogleCalendarError('invalid-response', 'Google returned an event without an ID.');
      }
      return { calendarId, eventId: returnedId };
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.status === 409) {
        return { calendarId, eventId };
      }
      throw error;
    }
  }

  async updateEvent(
    reference: ExternalCalendarEventRef,
    event: CalendarEventProjection,
  ): Promise<void> {
    await this.googleRequest(
      'PUT',
      calendarEventPath(reference),
      toGoogleCalendarEvent(event),
    );
  }

  async deleteEvent(reference: ExternalCalendarEventRef): Promise<void> {
    try {
      await this.googleRequest('DELETE', calendarEventPath(reference));
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === 'not-found') return;
      throw error;
    }
  }

  async eventExists(reference: ExternalCalendarEventRef): Promise<boolean> {
    try {
      await this.googleRequest('GET', calendarEventPath(reference));
      return true;
    } catch (error) {
      if (error instanceof GoogleCalendarError && error.kind === 'not-found') return false;
      throw error;
    }
  }

  private async googleRequest(
    method: CalendarHttpRequest['method'],
    url: string,
    body?: unknown,
  ): Promise<CalendarHttpResponse> {
    let refreshedAfterUnauthorized = false;
    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      const accessToken = await this.tokens.getAccessToken(this.configuration());
      let response: CalendarHttpResponse;
      try {
        response = await this.transport.request({
          method,
          url,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new GoogleCalendarError(
          'network',
          error instanceof Error ? error.message : 'Google Calendar API request failed.',
        );
      }

      if (response.status >= 200 && response.status < 300) return response;
      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        this.tokens.invalidateAccessToken();
        continue;
      }
      if (isRetryable(response) && attempt < MAX_RETRY_ATTEMPTS) {
        await this.wait(retryAfterMilliseconds(response, attempt, this.random));
        continue;
      }
      throw googleApiError(response);
    }
    throw new GoogleCalendarError('server', 'Google Calendar API retry limit was exceeded.');
  }
}

export function toGoogleCalendarEvent(
  event: CalendarEventProjection,
  id?: string,
): GoogleEventPayload {
  return {
    ...(id === undefined ? {} : { id }),
    summary: event.title,
    description: event.description,
    start: { date: event.startDate },
    end: { date: event.endDateExclusive },
    transparency: 'transparent',
    visibility: 'default',
    reminders: event.reminderMinutes === null
      ? { useDefault: false }
      : {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: event.reminderMinutes }],
        },
    extendedProperties: {
      private: { neuroRoadmapItemId: event.internalItemId },
    },
  };
}

export async function googleEventId(internalItemId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(internalItemId));
  return `nr${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function calendarEventsPath(calendarId: string): string {
  return `${GOOGLE_CALENDAR_ROOT}/calendars/${encodeURIComponent(calendarId)}/events`;
}

function calendarEventPath(reference: ExternalCalendarEventRef): string {
  return `${calendarEventsPath(reference.calendarId)}/${encodeURIComponent(reference.eventId)}`;
}

function parseCalendar(value: unknown): CalendarDescriptor | null {
  const record = objectValue(value);
  const id = stringValue(record['id']);
  const name = stringValue(record['summary']);
  if (id === null || name === null) return null;
  return { id, name, primary: record['primary'] === true };
}

function googleApiError(response: CalendarHttpResponse): GoogleCalendarError {
  const record = objectValue(response.json);
  const error = objectValue(record['error']);
  const message = stringValue(error['message']) ?? `Google Calendar API request failed (${response.status}).`;
  if (response.status === 401) return new GoogleCalendarError('authentication', message, response.status);
  if (response.status === 404 || response.status === 410) {
    return new GoogleCalendarError('not-found', message, response.status);
  }
  if (isQuotaResponse(response)) {
    return new GoogleCalendarError(
      'throttled',
      message,
      response.status,
      retryAfterSeconds(response),
    );
  }
  if (response.status === 403) return new GoogleCalendarError('permission', message, response.status);
  return new GoogleCalendarError(
    response.status >= 500 ? 'server' : 'invalid-response',
    message,
    response.status,
  );
}

function isRetryable(response: CalendarHttpResponse): boolean {
  return isQuotaResponse(response) || [500, 502, 503, 504].includes(response.status);
}

function isQuotaResponse(response: CalendarHttpResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  const errors = objectValue(objectValue(response.json)['error'])['errors'];
  if (!Array.isArray(errors)) return false;
  return errors.some((value) => {
    const reason = stringValue(objectValue(value)['reason']);
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded';
  });
}

function retryAfterMilliseconds(
  response: CalendarHttpResponse,
  attempt: number,
  random: () => number,
): number {
  const retrySeconds = retryAfterSeconds(response);
  if (retrySeconds !== undefined) return Math.min(64, retrySeconds) * 1_000;
  const jitterMilliseconds = Math.floor(Math.max(0, Math.min(1, random())) * 1_000);
  return Math.min(64_000, 2 ** attempt * 1_000 + jitterMilliseconds);
}

function retryAfterSeconds(response: CalendarHttpResponse): number | undefined {
  const header = Object.entries(response.headers)
    .find(([name]) => name.toLocaleLowerCase() === 'retry-after')?.[1];
  if (header === undefined) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
