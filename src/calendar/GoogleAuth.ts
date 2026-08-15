import type {
  CalendarHttpResponse,
  CalendarHttpTransport,
} from './CalendarHttpTransport';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const EXPIRY_SKEW_MS = 60_000;

export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'profile',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars',
] as const;

export interface GoogleAuthConfiguration {
  readonly clientId: string;
  readonly refreshTokenSecretId: string;
}

export interface GoogleSecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export interface GoogleAuthorizationSession {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface GoogleAuthorizationResponse {
  readonly state: string | null;
  readonly code: string | null;
  readonly error: string | null;
}

export interface GoogleTokenSet {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly grantedScopes: readonly string[];
}

export type GoogleAuthErrorKind =
  | 'configuration'
  | 'not-connected'
  | 'authorization-declined'
  | 'authorization-expired'
  | 'authentication-expired'
  | 'permission'
  | 'network'
  | 'server';

export class GoogleAuthError extends Error {
  constructor(
    readonly kind: GoogleAuthErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly scope: string;
}

/** Installed-app OAuth client using loopback redirects and PKCE S256 without a client secret. */
export class GoogleAuthClient {
  private cachedToken: GoogleTokenSet | null = null;

  constructor(
    private readonly transport: CalendarHttpTransport,
    private readonly secrets: GoogleSecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  async beginAuthorization(
    configuration: GoogleAuthConfiguration,
    redirectUri: string,
  ): Promise<GoogleAuthorizationSession> {
    validateConfiguration(configuration);
    validateLoopbackRedirect(redirectUri);
    const codeVerifier = randomUrlSafeValue(64);
    const codeChallenge = await pkceChallenge(codeVerifier);
    const state = randomUrlSafeValue(32);
    const parameters = new URLSearchParams({
      client_id: configuration.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return {
      authorizationUrl: `${AUTHORIZATION_ENDPOINT}?${parameters.toString()}`,
      redirectUri,
      state,
      codeVerifier,
    };
  }

  async completeAuthorization(
    configuration: GoogleAuthConfiguration,
    session: GoogleAuthorizationSession,
    response: GoogleAuthorizationResponse,
  ): Promise<GoogleTokenSet> {
    validateConfiguration(configuration);
    if (response.state === null || !constantTimeEqual(response.state, session.state)) {
      throw new GoogleAuthError('authorization-expired', 'Google authorization state did not match. Start Connect again.');
    }
    if (response.error !== null) {
      throw new GoogleAuthError(
        response.error === 'access_denied' ? 'authorization-declined' : 'authorization-expired',
        response.error === 'access_denied'
          ? 'Google authorization was declined.'
          : `Google authorization failed: ${response.error}.`,
      );
    }
    if (response.code === null || response.code.length === 0) {
      throw new GoogleAuthError('authorization-expired', 'Google returned no authorization code.');
    }
    const tokenResponse = await this.requestToken(formBody({
      client_id: configuration.clientId,
      code: response.code,
      code_verifier: session.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: session.redirectUri,
    }), 'Unable to complete Google authorization.');
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
      throw authEndpointError(tokenResponse, 'Unable to complete Google authorization.');
    }
    return this.acceptTokenResponse(configuration, tokenResponse.json, true);
  }

  async getAccessToken(configuration: GoogleAuthConfiguration): Promise<string> {
    validateConfiguration(configuration);
    if (this.cachedToken !== null && this.cachedToken.expiresAt - EXPIRY_SKEW_MS > this.now()) {
      return this.cachedToken.accessToken;
    }
    const refreshToken = this.readRefreshToken(configuration);
    if (refreshToken === null) {
      throw new GoogleAuthError('not-connected', 'Google Calendar is not connected.');
    }
    const response = await this.requestToken(formBody({
      client_id: configuration.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }), 'Unable to refresh Google authorization.');
    if (response.status < 200 || response.status >= 300) {
      const code = oauthErrorCode(response.json);
      if (code === 'invalid_grant' || code === 'invalid_client') {
        this.cachedToken = null;
        throw new GoogleAuthError(
          'authentication-expired',
          'Google authorization expired or was revoked. Reconnect the account.',
          response.status,
        );
      }
      throw authEndpointError(response, 'Unable to refresh Google authorization.');
    }
    return this.acceptTokenResponse(configuration, response.json, false).accessToken;
  }

  async disconnect(configuration: GoogleAuthConfiguration): Promise<void> {
    validateConfiguration(configuration);
    const refreshToken = this.readRefreshToken(configuration);
    if (refreshToken !== null) {
      let response: CalendarHttpResponse;
      try {
        response = await this.transport.request({
          method: 'POST',
          url: REVOCATION_ENDPOINT,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formBody({ token: refreshToken }),
        });
      } catch (error) {
        throw new GoogleAuthError(
          'network',
          error instanceof Error ? error.message : 'Google token revocation failed.',
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw authEndpointError(response, 'Google token revocation failed.');
      }
    }
    this.forgetLocalToken(configuration);
  }

  forgetLocalToken(configuration: GoogleAuthConfiguration): void {
    this.cachedToken = null;
    if (configuration.refreshTokenSecretId.length > 0) {
      this.secrets.setSecret(configuration.refreshTokenSecretId, '');
    }
  }

  invalidateAccessToken(): void {
    this.cachedToken = null;
  }

  hasRefreshToken(configuration: GoogleAuthConfiguration): boolean {
    return this.readRefreshToken(configuration) !== null;
  }

  private readRefreshToken(configuration: GoogleAuthConfiguration): string | null {
    if (configuration.refreshTokenSecretId.length === 0) return null;
    const value = this.secrets.getSecret(configuration.refreshTokenSecretId);
    return value === null || value.length === 0 ? null : value;
  }

  private acceptTokenResponse(
    configuration: GoogleAuthConfiguration,
    value: unknown,
    requireRefreshToken: boolean,
  ): GoogleTokenSet {
    const response = parseTokenResponse(value);
    if (requireRefreshToken && response.refresh_token === undefined) {
      throw new GoogleAuthError(
        'server',
        'Google did not issue a refresh token. Revoke the existing grant, then reconnect.',
      );
    }
    const grantedScopes = response.scope.split(/\s+/u).filter((scope) => scope.length > 0);
    const missingScopes = GOOGLE_CALENDAR_SCOPES.filter((scope) => !grantedScopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new GoogleAuthError(
        'permission',
        `Google authorization omitted required permissions: ${missingScopes.join(', ')}.`,
      );
    }
    if (response.refresh_token !== undefined) {
      this.secrets.setSecret(configuration.refreshTokenSecretId, response.refresh_token);
    }
    this.cachedToken = {
      accessToken: response.access_token,
      expiresAt: this.now() + response.expires_in * 1_000,
      grantedScopes,
    };
    return this.cachedToken;
  }

  private async requestToken(body: string, fallback: string): Promise<CalendarHttpResponse> {
    let response: CalendarHttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        url: TOKEN_ENDPOINT,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      throw new GoogleAuthError(
        'network',
        error instanceof Error ? error.message : fallback,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return response;
    }
    return response;
  }
}

function validateConfiguration(configuration: GoogleAuthConfiguration): void {
  if (configuration.clientId.trim().length === 0) {
    throw new GoogleAuthError('configuration', 'Google OAuth client ID is required.');
  }
  if (configuration.refreshTokenSecretId.trim().length === 0) {
    throw new GoogleAuthError('configuration', 'Google secure token storage is not initialized.');
  }
}

function validateLoopbackRedirect(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new GoogleAuthError('configuration', 'Google OAuth redirect URI is invalid.');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port.length === 0) {
    throw new GoogleAuthError('configuration', 'Google OAuth requires a 127.0.0.1 loopback redirect on desktop.');
  }
}

function parseTokenResponse(value: unknown): TokenResponse {
  const record = objectValue(value);
  const accessToken = stringValue(record['access_token']);
  const expiresIn = positiveNumber(record['expires_in']);
  const scope = stringValue(record['scope']);
  if (accessToken === null || expiresIn === null || scope === null) {
    throw new GoogleAuthError('server', 'Google returned an invalid token response.');
  }
  return {
    access_token: accessToken,
    refresh_token: stringValue(record['refresh_token']) ?? undefined,
    expires_in: expiresIn,
    scope,
  };
}

function authEndpointError(response: CalendarHttpResponse, fallback: string): GoogleAuthError {
  const record = objectValue(response.json);
  const description = stringValue(record['error_description']);
  return new GoogleAuthError(
    response.status >= 500 ? 'server' : 'network',
    description ?? fallback,
    response.status,
  );
}

function oauthErrorCode(value: unknown): string | null {
  return stringValue(objectValue(value)['error']);
}

function randomUrlSafeValue(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function formBody(values: Readonly<Record<string, string>>): string {
  return new URLSearchParams(values).toString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
