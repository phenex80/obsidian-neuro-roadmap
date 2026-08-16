import { Platform } from 'obsidian';
import type { GoogleAuthorizationResponse } from './GoogleAuth';

const CALLBACK_PATH = '/';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface GoogleLoopbackSession {
  readonly redirectUri: string;
  readonly response: Promise<GoogleAuthorizationResponse>;
  close(): void;
}

/**
 * The small part of Node's HTTP surface used by the loopback receiver.
 *
 * Keeping this structural type local prevents a Node module from becoming a
 * top-level dependency of the mobile-loadable plugin module. The actual
 * module is acquired only after the desktop platform check below.
 */
interface LoopbackRequest {
  readonly url?: string;
}

interface LoopbackResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body: string): void;
}

interface LoopbackAddress {
  readonly port: number;
}

interface LoopbackServer {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'listening', listener: () => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'listening', listener: () => void): this;
  listen(port: number, hostname: string): this;
  address(): LoopbackAddress | string | null;
  close(): this;
}

interface LoopbackHttpModule {
  createServer(
    listener: (request: LoopbackRequest, response: LoopbackResponse) => void,
  ): LoopbackServer;
}

export interface GoogleLoopbackRuntime {
  readonly isDesktopApp: boolean;
  loadHttpModule(): LoopbackHttpModule;
}

function loadDesktopHttpModule(): LoopbackHttpModule {
  const httpModule: unknown = require('http');
  if (!isLoopbackHttpModule(httpModule)) {
    throw new Error('Google OAuth callback server could not load Node HTTP on desktop.');
  }
  return httpModule;
}

function isLoopbackHttpModule(value: unknown): value is LoopbackHttpModule {
  return typeof value === 'object' && value !== null && 'createServer' in value &&
    typeof value.createServer === 'function';
}

const DEFAULT_RUNTIME: GoogleLoopbackRuntime = {
  get isDesktopApp(): boolean {
    return Platform.isDesktopApp;
  },
  loadHttpModule: loadDesktopHttpModule,
};

/** One-shot localhost receiver for the official desktop installed-app OAuth flow. */
export async function startGoogleLoopbackServer(
  this: void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  runtime: GoogleLoopbackRuntime = DEFAULT_RUNTIME,
): Promise<GoogleLoopbackSession> {
  if (!runtime.isDesktopApp) {
    throw new Error('Google Calendar connection is available only on desktop.');
  }
  const httpModule = runtime.loadHttpModule();
  let timeout: ReturnType<typeof window.activeWindow.setTimeout> | undefined;
  let settled = false;
  let resolveResponse: (value: GoogleAuthorizationResponse) => void = () => undefined;
  let rejectResponse: (reason: unknown) => void = () => undefined;

  const response = new Promise<GoogleAuthorizationResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let server: LoopbackServer | null = httpModule.createServer((request, reply) => {
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
    if (timeout !== undefined) window.activeWindow.clearTimeout(timeout);
    timeout = undefined;
    server?.close();
    server = null;
  };
  timeout = window.activeWindow.setTimeout(() => {
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
