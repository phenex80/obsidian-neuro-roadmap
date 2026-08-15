import type { CalendarEventProjection } from '../core/CalendarCore';
import type {
  CalendarConnectionStatus,
  CalendarDescriptor,
  CalendarProvider,
  CalendarProviderCapabilities,
  ExternalCalendarEventRef,
} from '../core/CalendarProvider';
import type {
  MicrosoftAuthConfiguration,
  MicrosoftHttpRequest,
  MicrosoftHttpResponse,
  MicrosoftHttpTransport,
} from './MicrosoftAuth';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const MAX_RETRY_ATTEMPTS = 2;

export interface MicrosoftAccessTokenProvider {
  getAccessToken(configuration: MicrosoftAuthConfiguration): Promise<string>;
  invalidateAccessToken(): void;
}

export interface MicrosoftAccountProfile {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export type MicrosoftGraphErrorKind =
  | 'authentication'
  | 'permission'
  | 'not-found'
  | 'throttled'
  | 'server'
  | 'network'
  | 'invalid-response';

export class MicrosoftGraphError extends Error {
  constructor(
    readonly kind: MicrosoftGraphErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'MicrosoftGraphError';
  }
}

interface GraphEventPayload {
  readonly subject: string;
  readonly body: { readonly contentType: 'text'; readonly content: string };
  readonly start: { readonly dateTime: string; readonly timeZone: 'UTC' };
  readonly end: { readonly dateTime: string; readonly timeZone: 'UTC' };
  readonly isAllDay: true;
  readonly showAs: 'free';
  readonly isReminderOn: boolean;
  readonly reminderMinutesBeforeStart?: number;
  readonly transactionId?: string;
}

/** Microsoft Graph implementation of the provider boundary; Calendar Core remains authoritative. */
export class MicrosoftCalendarProvider implements CalendarProvider {
  readonly id = 'microsoft';
  readonly displayName = 'Microsoft 365';
  readonly capabilities: CalendarProviderCapabilities = {
    export: false,
    remoteCalendars: true,
    create: true,
    update: true,
    delete: true,
    reminders: true,
  };

  constructor(
    private readonly configuration: () => MicrosoftAuthConfiguration,
    private readonly tokens: MicrosoftAccessTokenProvider,
    private readonly transport: MicrosoftHttpTransport,
    private readonly wait: (milliseconds: number) => Promise<void> = waitFor,
  ) {}

  async initialize(): Promise<CalendarConnectionStatus> {
    try {
      const profile = await this.getAccountProfile();
      return { connected: true, message: profile.email };
    } catch (error) {
      return {
        connected: false,
        message: error instanceof Error ? error.message : 'Microsoft 365 connection failed.',
      };
    }
  }

  async getAccountProfile(): Promise<MicrosoftAccountProfile> {
    const response = await this.graphRequest(
      'GET',
      '/me?$select=id,displayName,mail,userPrincipalName',
    );
    const record = objectValue(response.json);
    const id = stringValue(record['id']);
    const displayName = stringValue(record['displayName']);
    const email = stringValue(record['mail']) ?? stringValue(record['userPrincipalName']);
    if (id === null || displayName === null || email === null) {
      throw new MicrosoftGraphError('invalid-response', 'Microsoft returned an invalid account profile.');
    }
    return { id, displayName, email };
  }

  async listCalendars(): Promise<readonly CalendarDescriptor[]> {
    const calendars: CalendarDescriptor[] = [];
    let url: string | null = `${GRAPH_ROOT}/me/calendars?$select=id,name,isDefaultCalendar`;
    while (url !== null) {
      const response = await this.graphRequest('GET', url);
      const record = objectValue(response.json);
      const values = Array.isArray(record['value']) ? record['value'] : [];
      for (const value of values) {
        const calendar = parseCalendar(value);
        if (calendar !== null) calendars.push(calendar);
      }
      url = stringValue(record['@odata.nextLink']);
    }
    return calendars.sort(
      (left, right) => Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name),
    );
  }

  async createCalendar(name: string): Promise<CalendarDescriptor> {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      throw new MicrosoftGraphError('invalid-response', 'Calendar name cannot be empty.');
    }
    const response = await this.graphRequest('POST', '/me/calendars', { name: trimmedName });
    const calendar = parseCalendar(response.json);
    if (calendar === null) {
      throw new MicrosoftGraphError('invalid-response', 'Microsoft returned an invalid calendar.');
    }
    return calendar;
  }

  async createEvent(
    calendarId: string,
    event: CalendarEventProjection,
  ): Promise<ExternalCalendarEventRef> {
    const response = await this.graphRequest(
      'POST',
      calendarEventPath(calendarId),
      toMicrosoftGraphEvent(event, true),
    );
    const eventId = stringValue(objectValue(response.json)['id']);
    if (eventId === null) {
      throw new MicrosoftGraphError('invalid-response', 'Microsoft returned an event without an ID.');
    }
    return { calendarId, eventId };
  }

  async updateEvent(
    reference: ExternalCalendarEventRef,
    event: CalendarEventProjection,
  ): Promise<void> {
    await this.graphRequest(
      'PATCH',
      `${calendarEventPath(reference.calendarId)}/${encodeURIComponent(reference.eventId)}`,
      toMicrosoftGraphEvent(event, false),
    );
  }

  async deleteEvent(reference: ExternalCalendarEventRef): Promise<void> {
    try {
      await this.graphRequest(
        'DELETE',
        `${calendarEventPath(reference.calendarId)}/${encodeURIComponent(reference.eventId)}`,
      );
    } catch (error) {
      if (error instanceof MicrosoftGraphError && error.kind === 'not-found') return;
      throw error;
    }
  }

  async eventExists(reference: ExternalCalendarEventRef): Promise<boolean> {
    try {
      await this.graphRequest(
        'GET',
        `${calendarEventPath(reference.calendarId)}/${encodeURIComponent(reference.eventId)}?$select=id`,
      );
      return true;
    } catch (error) {
      if (error instanceof MicrosoftGraphError && error.kind === 'not-found') return false;
      throw error;
    }
  }

  private async graphRequest(
    method: MicrosoftHttpRequest['method'],
    pathOrUrl: string,
    body?: unknown,
  ): Promise<MicrosoftHttpResponse> {
    let refreshedAfterUnauthorized = false;
    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
      const accessToken = await this.tokens.getAccessToken(this.configuration());
      let response: MicrosoftHttpResponse;
      try {
        response = await this.transport.request({
          method,
          url: pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_ROOT}${pathOrUrl}`,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new MicrosoftGraphError(
          'network',
          error instanceof Error ? error.message : 'Microsoft Graph request failed.',
        );
      }

      if (response.status >= 200 && response.status < 300) return response;
      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        this.tokens.invalidateAccessToken();
        continue;
      }
      if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < MAX_RETRY_ATTEMPTS) {
        await this.wait(retryAfterMilliseconds(response, attempt));
        continue;
      }
      throw graphError(response);
    }
    throw new MicrosoftGraphError('server', 'Microsoft Graph retry limit was exceeded.');
  }
}

export function toMicrosoftGraphEvent(
  event: CalendarEventProjection,
  includeTransactionId: boolean,
): GraphEventPayload {
  return {
    subject: event.title,
    body: { contentType: 'text', content: event.description },
    start: { dateTime: `${event.startDate}T00:00:00`, timeZone: 'UTC' },
    end: { dateTime: `${event.endDateExclusive}T00:00:00`, timeZone: 'UTC' },
    isAllDay: true,
    showAs: 'free',
    isReminderOn: event.reminderMinutes !== null,
    ...(event.reminderMinutes === null
      ? {}
      : { reminderMinutesBeforeStart: event.reminderMinutes }),
    ...(includeTransactionId ? { transactionId: event.internalItemId } : {}),
  };
}

function calendarEventPath(calendarId: string): string {
  return `/me/calendars/${encodeURIComponent(calendarId)}/events`;
}

function parseCalendar(value: unknown): CalendarDescriptor | null {
  const record = objectValue(value);
  const id = stringValue(record['id']);
  const name = stringValue(record['name']);
  if (id === null || name === null) return null;
  return { id, name, primary: record['isDefaultCalendar'] === true };
}

function graphError(response: MicrosoftHttpResponse): MicrosoftGraphError {
  const record = objectValue(response.json);
  const error = objectValue(record['error']);
  const message = stringValue(error['message']) ?? `Microsoft Graph request failed (${response.status}).`;
  if (response.status === 401) return new MicrosoftGraphError('authentication', message, response.status);
  if (response.status === 403) return new MicrosoftGraphError('permission', message, response.status);
  if (response.status === 404 || response.status === 410) {
    return new MicrosoftGraphError('not-found', message, response.status);
  }
  if (response.status === 429) {
    return new MicrosoftGraphError(
      'throttled',
      message,
      response.status,
      retryAfterSeconds(response),
    );
  }
  return new MicrosoftGraphError(
    response.status >= 500 ? 'server' : 'invalid-response',
    message,
    response.status,
  );
}

function retryAfterMilliseconds(response: MicrosoftHttpResponse, attempt: number): number {
  return Math.min(60, retryAfterSeconds(response) ?? 2 ** attempt) * 1_000;
}

function retryAfterSeconds(response: MicrosoftHttpResponse): number | undefined {
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
