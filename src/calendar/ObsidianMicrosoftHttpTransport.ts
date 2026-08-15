import { requestUrl } from 'obsidian';
import type {
  MicrosoftHttpRequest,
  MicrosoftHttpResponse,
  MicrosoftHttpTransport,
} from './MicrosoftAuth';

const DEFAULT_TIMEOUT_MS = 20_000;

/** Cross-platform Obsidian HTTP adapter; requestUrl avoids browser CORS restrictions. */
export class ObsidianMicrosoftHttpTransport implements MicrosoftHttpTransport {
  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  async request(request: MicrosoftHttpRequest): Promise<MicrosoftHttpResponse> {
    let timeout: number | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = window.setTimeout(
        () => reject(new Error('Microsoft request timed out.')),
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
