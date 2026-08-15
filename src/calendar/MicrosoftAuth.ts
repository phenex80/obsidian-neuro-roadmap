export const MICROSOFT_GRAPH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'User.Read',
  'Calendars.ReadWrite',
] as const;

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const EXPIRY_SKEW_MS = 60_000;

export interface MicrosoftAuthConfiguration {
  readonly clientId: string;
  readonly tenant: string;
  readonly refreshTokenSecretId: string;
}

export interface MicrosoftHttpRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface MicrosoftHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
  readonly text: string;
}

export interface MicrosoftHttpTransport {
  request(request: MicrosoftHttpRequest): Promise<MicrosoftHttpResponse>;
}

export interface MicrosoftSecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export interface MicrosoftDeviceCodeSession {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly message: string;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
}

export interface MicrosoftTokenSet {
  readonly accessToken: string;
  readonly expiresAt: number;
}

export type MicrosoftAuthErrorKind =
  | 'configuration'
  | 'not-connected'
  | 'authorization-declined'
  | 'authorization-expired'
  | 'authentication-expired'
  | 'network'
  | 'server';

export class MicrosoftAuthError extends Error {
  constructor(
    readonly kind: MicrosoftAuthErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MicrosoftAuthError';
  }
}

interface DeviceCodeResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly message?: string;
  readonly expires_in: number;
  readonly interval?: number;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
}

/** Public-client Device Authorization Grant with refresh tokens kept outside data.json. */
export class MicrosoftAuthClient {
  private cachedToken: MicrosoftTokenSet | null = null;

  constructor(
    private readonly transport: MicrosoftHttpTransport,
    private readonly secrets: MicrosoftSecretStore,
    private readonly now: () => number = Date.now,
    private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> = waitFor,
  ) {}

  async beginDeviceCode(
    configuration: MicrosoftAuthConfiguration,
  ): Promise<MicrosoftDeviceCodeSession> {
    validateConfiguration(configuration);
    const response = await this.requestTokenEndpoint(
      configuration,
      'devicecode',
      formBody({
        client_id: configuration.clientId,
        scope: MICROSOFT_GRAPH_SCOPES.join(' '),
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      throw authEndpointError(response, 'Unable to start Microsoft sign-in.');
    }
    const payload = parseDeviceCodeResponse(response.json);
    return {
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      message: payload.message ?? `Open ${payload.verification_uri} and enter ${payload.user_code}.`,
      expiresAt: this.now() + payload.expires_in * 1_000,
      intervalSeconds: Math.max(1, payload.interval ?? 5),
    };
  }

  async completeDeviceCode(
    configuration: MicrosoftAuthConfiguration,
    session: MicrosoftDeviceCodeSession,
    signal?: AbortSignal,
  ): Promise<MicrosoftTokenSet> {
    let intervalSeconds = session.intervalSeconds;
    while (this.now() < session.expiresAt) {
      signal?.throwIfAborted();
      const response = await this.requestTokenEndpoint(
        configuration,
        'token',
        formBody({
          grant_type: DEVICE_GRANT_TYPE,
          client_id: configuration.clientId,
          device_code: session.deviceCode,
        }),
      );
      if (response.status >= 200 && response.status < 300) {
        return this.acceptTokenResponse(configuration, response.json, true);
      }
      const code = oauthErrorCode(response.json);
      if (code === 'authorization_pending') {
        await this.wait(intervalSeconds * 1_000, signal);
        continue;
      }
      if (code === 'slow_down') {
        intervalSeconds += 5;
        await this.wait(intervalSeconds * 1_000, signal);
        continue;
      }
      if (code === 'authorization_declined') {
        throw new MicrosoftAuthError('authorization-declined', 'Microsoft sign-in was declined.');
      }
      if (code === 'expired_token' || code === 'bad_verification_code') {
        throw new MicrosoftAuthError('authorization-expired', 'Microsoft sign-in code expired.');
      }
      throw authEndpointError(response, 'Microsoft sign-in failed.');
    }
    throw new MicrosoftAuthError('authorization-expired', 'Microsoft sign-in code expired.');
  }

  async getAccessToken(configuration: MicrosoftAuthConfiguration): Promise<string> {
    validateConfiguration(configuration);
    if (this.cachedToken !== null && this.cachedToken.expiresAt - EXPIRY_SKEW_MS > this.now()) {
      return this.cachedToken.accessToken;
    }
    const refreshToken = this.secrets.getSecret(configuration.refreshTokenSecretId);
    if (refreshToken === null || refreshToken.length === 0) {
      throw new MicrosoftAuthError('not-connected', 'Microsoft 365 is not connected.');
    }
    const response = await this.requestTokenEndpoint(
      configuration,
      'token',
      formBody({
        grant_type: 'refresh_token',
        client_id: configuration.clientId,
        refresh_token: refreshToken,
        scope: MICROSOFT_GRAPH_SCOPES.join(' '),
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      const code = oauthErrorCode(response.json);
      if (code === 'invalid_grant' || code === 'interaction_required') {
        this.cachedToken = null;
        throw new MicrosoftAuthError(
          'authentication-expired',
          'Microsoft authorization expired or was revoked. Reconnect the account.',
          response.status,
        );
      }
      throw authEndpointError(response, 'Unable to refresh Microsoft authorization.');
    }
    return this.acceptTokenResponse(configuration, response.json, false).accessToken;
  }

  disconnect(configuration: MicrosoftAuthConfiguration): void {
    this.cachedToken = null;
    if (configuration.refreshTokenSecretId.length > 0) {
      this.secrets.setSecret(configuration.refreshTokenSecretId, '');
    }
  }

  invalidateAccessToken(): void {
    this.cachedToken = null;
  }

  hasRefreshToken(configuration: MicrosoftAuthConfiguration): boolean {
    if (configuration.refreshTokenSecretId.length === 0) return false;
    return (this.secrets.getSecret(configuration.refreshTokenSecretId)?.length ?? 0) > 0;
  }

  private acceptTokenResponse(
    configuration: MicrosoftAuthConfiguration,
    value: unknown,
    requireRefreshToken: boolean,
  ): MicrosoftTokenSet {
    const response = parseTokenResponse(value);
    if (requireRefreshToken && response.refresh_token === undefined) {
      throw new MicrosoftAuthError(
        'server',
        'Microsoft did not issue a refresh token. Verify offline_access and public client settings.',
      );
    }
    if (response.refresh_token !== undefined) {
      this.secrets.setSecret(configuration.refreshTokenSecretId, response.refresh_token);
    }
    this.cachedToken = {
      accessToken: response.access_token,
      expiresAt: this.now() + response.expires_in * 1_000,
    };
    return this.cachedToken;
  }

  private async requestTokenEndpoint(
    configuration: MicrosoftAuthConfiguration,
    endpoint: 'devicecode' | 'token',
    body: string,
  ): Promise<MicrosoftHttpResponse> {
    try {
      return await this.transport.request({
        method: 'POST',
        url: `${authority(configuration.tenant)}/${endpoint}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      throw new MicrosoftAuthError(
        'network',
        error instanceof Error ? error.message : 'Microsoft identity request failed.',
      );
    }
  }
}

function authority(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

function validateConfiguration(configuration: MicrosoftAuthConfiguration): void {
  if (configuration.clientId.trim().length === 0) {
    throw new MicrosoftAuthError('configuration', 'Microsoft Application (client) ID is required.');
  }
  if (configuration.tenant.trim().length === 0) {
    throw new MicrosoftAuthError('configuration', 'Microsoft tenant is required.');
  }
  if (configuration.refreshTokenSecretId.trim().length === 0) {
    throw new MicrosoftAuthError('configuration', 'Microsoft secure token storage is not initialized.');
  }
}

function formBody(values: Readonly<Record<string, string>>): string {
  return new URLSearchParams(values).toString();
}

function parseDeviceCodeResponse(value: unknown): DeviceCodeResponse {
  const record = objectValue(value);
  const deviceCode = stringValue(record['device_code']);
  const userCode = stringValue(record['user_code']);
  const verificationUri = stringValue(record['verification_uri']);
  const expiresIn = numberValue(record['expires_in']);
  if (deviceCode === null || userCode === null || verificationUri === null || expiresIn === null) {
    throw new MicrosoftAuthError('server', 'Microsoft returned an invalid device authorization response.');
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    message: stringValue(record['message']) ?? undefined,
    expires_in: expiresIn,
    interval: numberValue(record['interval']) ?? undefined,
  };
}

function parseTokenResponse(value: unknown): TokenResponse {
  const record = objectValue(value);
  const accessToken = stringValue(record['access_token']);
  const expiresIn = numberValue(record['expires_in']);
  if (accessToken === null || expiresIn === null) {
    throw new MicrosoftAuthError('server', 'Microsoft returned an invalid token response.');
  }
  return {
    access_token: accessToken,
    refresh_token: stringValue(record['refresh_token']) ?? undefined,
    expires_in: expiresIn,
  };
}

function authEndpointError(response: MicrosoftHttpResponse, fallback: string): MicrosoftAuthError {
  const record = objectValue(response.json);
  const description = stringValue(record['error_description']);
  return new MicrosoftAuthError(
    response.status >= 500 ? 'server' : 'network',
    description ?? fallback,
    response.status,
  );
}

function oauthErrorCode(value: unknown): string | null {
  return stringValue(objectValue(value)['error']);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function waitFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
