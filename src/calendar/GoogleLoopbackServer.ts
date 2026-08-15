import { Platform } from 'obsidian';
import type { Server } from 'node:http';
import type { GoogleAuthorizationResponse } from './GoogleAuth';

const CALLBACK_PATH = '/';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface GoogleLoopbackSession {
  readonly redirectUri: string;
  readonly response: Promise<GoogleAuthorizationResponse>;
  close(): void;
}

export interface GoogleLoopbackRuntime {
  readonly isDesktopApp: boolean;
  loadHttpModule(): typeof import('node:http');
}

function loadDesktopHttpModule(): typeof import('node:http') {
  return require('http') as typeof import('node:http');
}

const DEFAULT_RUNTIME: GoogleLoopbackRuntime = {
  get isDesktopApp(): boolean {
    return Platform.isDesktopApp;
  },
  loadHttpModule: loadDesktopHttpModule,
};

/** One-shot localhost receiver for the official desktop installed-app OAuth flow. */
export async function startGoogleLoopbackServer(
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runtime: GoogleLoopbackRuntime = DEFAULT_RUNTIME,
): Promise<GoogleLoopbackSession> {
  if (!runtime.isDesktopApp) {
    throw new Error('Google Calendar connection is available only on desktop.');
  }
  const { createServer } = runtime.loadHttpModule();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
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
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server?.off('listening', onListening);
      settled = true;
      reject(error);
    };
    const onListening = (): void => {
      server?.off('error', onError);
      resolve();
    };
    server?.once('error', onError);
    server?.once('listening', onListening);
    server?.listen(0, '127.0.0.1');
  });

  server.once('error', (error) => {
    if (!settled) {
      settled = true;
      rejectResponse(error);
    }
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
    if (!settled) {
      settled = true;
      rejectResponse(new Error('Google authorization was cancelled.'));
    }
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    timeout = undefined;
    server?.close();
    server = null;
  };
  timeout = globalThis.setTimeout(() => {
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
