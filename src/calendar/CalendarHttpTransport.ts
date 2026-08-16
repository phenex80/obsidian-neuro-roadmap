import { requestUrl } from 'obsidian';

const DEFAULT_TIMEOUT_MS = 20_000;

export interface CalendarHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface CalendarHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
  readonly text: string;
}

export interface CalendarHttpTransport {
  request(request: CalendarHttpRequest): Promise<CalendarHttpResponse>;
}

/** Cross-platform API transport; requestUrl avoids renderer CORS restrictions. */
export class ObsidianCalendarHttpTransport implements CalendarHttpTransport {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async request(request: CalendarHttpRequest): Promise<CalendarHttpResponse> {
    let timeout: number | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(
        () => reject(new Error('Calendar request timed out.')),
        this.timeoutMs,
      );
    });
    try {
      const response = await Promise.race([
        requestUrl({
          url: request.url,
          method: request.method,
          headers: request.headers === undefined ? undefined : { ...request.headers },
          body: request.body,
          throw: false,
        }),
        timeoutPromise,
      ]);
      return {
        status: response.status,
        headers: response.headers,
        json: parseResponseJson(response.text),
        text: response.text,
      };
    } finally {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
    }
  }
}

function parseResponseJson(value: string): unknown {
  if (value.trim().length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
