/**
 * AWS SSO OIDC device-code login, driven from the admin page.
 *
 * The flow is the one kiro-cli runs for `login --use-device-flow`, done over
 * HTTP instead of spawning kiro-cli in a PTY:
 *
 * 1. `RegisterClient` creates a public OIDC client (clientId / clientSecret)
 *    with the CodeWhisperer scopes, bound to the start URL.
 * 2. `StartDeviceAuthorization` returns a user code and a verification URL
 *    that the admin opens in any browser and confirms.
 * 3. `CreateToken` with the device-code grant is polled in the background
 *    until the user confirms; the resulting refresh token plus the client
 *    registration is a complete pool credential.
 *
 * All three bodies are camelCase (Smithy wire format), like the refresh call.
 */

import crypto from 'node:crypto';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { applyRetryHeaders } from '../kiro/retry-executor.js';
import { getLogger } from '../shared/logger.js';
import type { AccountPool } from './account-pool.js';
import { BUILDER_ID_START_URL, isBuilderIdStartUrl, resolveProfile } from './profiles.js';

const SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
];
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SESSION_RETENTION_MS = 15 * 60_000;
const ERROR_TYPE_CODES: Record<string, string> = {
  AuthorizationPendingException: 'authorization_pending',
  SlowDownException: 'slow_down',
  ExpiredTokenException: 'expired_token',
  AccessDeniedException: 'access_denied',
};

export type LoginStatus = 'pending' | 'success' | 'failed' | 'expired' | 'cancelled';

export interface LoginSessionView {
  id: string;
  status: LoginStatus;
  startUrl: string;
  region: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: string;
  accountId?: string;
  error?: string;
}

interface LoginSession extends LoginSessionView {
  name?: string;
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  intervalMs: number;
  timer?: NodeJS.Timeout;
  finishedAt?: number;
}

export interface StartLoginInput {
  /** IAM Identity Center start URL; omitted or the Builder ID URL means Builder ID. */
  startUrl?: string;
  region?: string;
  name?: string;
}

export class DeviceLoginManager {
  readonly #pool: AccountPool;
  readonly #sessions = new Map<string, LoginSession>();

  constructor(pool: AccountPool) {
    this.#pool = pool;
  }

  async start(input: StartLoginInput): Promise<LoginSessionView> {
    this.#gc();
    const startUrl = normalizeStartUrl(input.startUrl);
    const region = (input.region?.trim() || 'us-east-1').toLowerCase();
    if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) throw new Error(`invalid region: ${region}`);

    const reg = await oidcPost<{ clientId: string; clientSecret: string }>(
      region,
      'client/register',
      {
        clientName: 'kiro2api',
        clientType: 'public',
        scopes: SCOPES,
        grantTypes: [DEVICE_GRANT, 'refresh_token'],
        issuerUrl: startUrl,
      },
    );
    const auth = await oidcPost<{
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      expiresIn: number;
      interval?: number;
    }>(region, 'device_authorization', {
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      startUrl,
    });

    const session: LoginSession = {
      id: crypto.randomBytes(6).toString('hex'),
      status: 'pending',
      startUrl,
      region,
      name: input.name,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      verificationUriComplete: auth.verificationUriComplete,
      expiresAt: new Date(Date.now() + auth.expiresIn * 1000).toISOString(),
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      deviceCode: auth.deviceCode,
      intervalMs: Math.max(auth.interval ?? 5, 1) * 1000,
    };
    this.#sessions.set(session.id, session);
    this.#schedule(session);
    getLogger().info({ msg: 'device login started', session: session.id, region });
    return view(session);
  }

  get(id: string): LoginSessionView | undefined {
    const s = this.#sessions.get(id);
    return s && view(s);
  }

  cancel(id: string): boolean {
    const s = this.#sessions.get(id);
    if (!s) return false;
    if (s.status === 'pending') this.#finish(s, 'cancelled');
    return true;
  }

  #schedule(s: LoginSession): void {
    s.timer = setTimeout(() => void this.#poll(s), s.intervalMs);
    s.timer.unref();
  }

  async #poll(s: LoginSession): Promise<void> {
    if (s.status !== 'pending') return;
    if (Date.now() > Date.parse(s.expiresAt)) {
      this.#finish(s, 'expired', 'device code expired before the login was confirmed');
      return;
    }
    let token: { accessToken: string; refreshToken?: string; expiresIn?: number };
    try {
      token = await oidcPost(s.region, 'token', {
        clientId: s.clientId,
        clientSecret: s.clientSecret,
        grantType: DEVICE_GRANT,
        deviceCode: s.deviceCode,
      });
    } catch (e) {
      const code = e instanceof OidcError ? e.code : undefined;
      if (code === 'authorization_pending') return this.#schedule(s);
      if (code === 'slow_down') {
        s.intervalMs += 5_000;
        return this.#schedule(s);
      }
      if (code === 'expired_token') return this.#finish(s, 'expired', 'device code expired');
      if (code === 'access_denied') return this.#finish(s, 'failed', 'login was denied');
      if (!(e instanceof OidcError)) {
        // Network blip: keep polling until the device code expires.
        getLogger().warn({ msg: 'device login poll failed', session: s.id, error: String(e) });
        return this.#schedule(s);
      }
      return this.#finish(s, 'failed', e.message);
    }

    if (!token.refreshToken) {
      return this.#finish(s, 'failed', 'CreateToken returned no refresh token');
    }
    if (s.status !== 'pending') return;
    try {
      const profile = await resolveProfile(token.accessToken, s.startUrl);
      const result = await this.#pool.addAccount({
        name: s.name,
        source: isBuilderIdStartUrl(s.startUrl) ? 'builder-id' : 'idc',
        startUrl: s.startUrl,
        credentials: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: new Date(Date.now() + (token.expiresIn ?? 3600) * 1000).toISOString(),
          clientId: s.clientId,
          clientSecret: s.clientSecret,
          region: s.region,
          profileArn: profile?.profileArn,
          apiRegion: profile?.apiRegion,
        },
      });
      s.accountId = result.id;
      if (result.verified) this.#finish(s, 'success');
      else this.#finish(s, 'failed', `account added but verification failed: ${result.error}`);
    } catch (e) {
      this.#finish(s, 'failed', e instanceof Error ? e.message : String(e));
    }
  }

  #finish(s: LoginSession, status: LoginStatus, error?: string): void {
    if (s.timer) clearTimeout(s.timer);
    s.status = status;
    s.error = error;
    s.finishedAt = Date.now();
    getLogger().info({ msg: 'device login finished', session: s.id, status, error });
  }

  #gc(): void {
    const now = Date.now();
    for (const [id, s] of this.#sessions) {
      if (s.finishedAt && now - s.finishedAt > SESSION_RETENTION_MS) this.#sessions.delete(id);
    }
  }
}

function view(s: LoginSession): LoginSessionView {
  return {
    id: s.id,
    status: s.status,
    startUrl: s.startUrl,
    region: s.region,
    userCode: s.userCode,
    verificationUri: s.verificationUri,
    verificationUriComplete: s.verificationUriComplete,
    expiresAt: s.expiresAt,
    accountId: s.accountId,
    error: s.error,
  };
}

function normalizeStartUrl(raw: string | undefined): string {
  const url = raw?.trim();
  if (!url) return BUILDER_ID_START_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid start URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error('start URL must use https');
  return url.replace(/\/+$/, '');
}

class OidcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

async function oidcPost<T>(region: string, path: string, body: unknown): Promise<T> {
  const host = `oidc.${region}.amazonaws.com`;
  const headers: Record<string, string> = { 'content-type': 'application/json', host };
  applyRetryHeaders(headers, uuidv4(), 1, { maxAttempts: 4, kiroAttemptHeader: false });
  const response = await axios.post(`https://${host}/${path}`, body, {
    headers,
    timeout: 30_000,
    validateStatus: () => true,
  });
  if (response.status >= 200 && response.status < 300) return response.data as T;
  const data = (response.data ?? {}) as {
    error?: string;
    error_description?: string;
    message?: string;
  };
  const errorType = String(response.headers['x-amzn-errortype'] ?? '').split(':')[0];
  const code = data.error ?? ERROR_TYPE_CODES[errorType];
  const detail =
    data.error_description ?? data.message ?? JSON.stringify(response.data).slice(0, 300);
  throw new OidcError(
    response.status,
    code,
    `OIDC ${path} HTTP ${response.status}: ${code ?? ''} ${detail}`.trim(),
  );
}
