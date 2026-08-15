import { createServer, type Server } from 'node:http';
import type { GoogleAuthorizationResponse } from './GoogleAuth';

const CALLBACK_PATH = '/oauth2/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface GoogleLoopbackSession {
  readonly redirectUri: string;
  readonly response: Promise<GoogleAuthorizationResponse>;
  close(): void;
}

/** One-shot localhost receiver for the official desktop installed-app OAuth flow. */
export async function startGoogleLoopbackServer(
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GoogleLoopbackSession> {
  let timeout: number | undefined;
  let settled = false;
  let resolveResponse: (value: GoogleAuthorizationResponse) => void = () => undefined;
  let rejectResponse: (reason: unknown) => void = () => undefined;

  const response = new Promise<GoogleAuthorizationResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let server: Server | null = createServer((request, reply) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== CALLBACK_PATH) {
      reply.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      reply.end('Not found');
      return;
    }
    if (settled) {
      reply.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      reply.end('Authorization response already received.');
      return;
    }
    settled = true;
    reply.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    reply.end('<!doctype html><html><body><h1>Neuro Roadmap connected</h1><p>You can close this browser tab and return to Obsidian.</p></body></html>');
    resolveResponse({
      state: requestUrl.searchParams.get('state'),
      code: requestUrl.searchParams.get('code'),
      error: requestUrl.searchParams.get('error'),
    });
  });
  server.once('error', (error) => {
    if (!settled) {
      settled = true;
      rejectResponse(error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    if (server === null) {
      reject(new Error('Google OAuth callback server could not be created.'));
      return;
    }
    server.listen(0, '127.0.0.1', resolve);
  });

  if (server === null) {
    throw new Error('Google OAuth callback server could not be started.');
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Google OAuth callback server returned no loopback port.');
  }

  const close = (): void => {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = undefined;
    server?.close();
    server = null;
  };
  timeout = window.setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectResponse(new Error('Google authorization timed out. Start Connect again.'));
    }
    close();
  }, timeoutMs);
  void response.then(close, close);

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    response,
    close,
  };
}
