/**
 * Parse credentials pasted into the admin page.
 *
 * Accepted shapes (one paste may hold several, as a JSON array or as JSON
 * objects pasted back to back):
 *
 * - kiro.rs `credentials.json` entries and similar camelCase exports:
 *   `{ refreshToken, clientId, clientSecret, region?, profileArn?, ... }`,
 *   optionally nested as `{ credentials: {...} }` or `{ accounts: [...] }`.
 * - kiro-cli SQLite values (snake_case): the token row
 *   `{ access_token, refresh_token, expires_at, region, start_url }` plus the
 *   device-registration row `{ client_id, client_secret }`.
 * - Kiro IDE `~/.aws/sso/cache` files: `kiro-auth-token.json` plus the
 *   `<clientIdHash>.json` registration file.
 *
 * A registration-only object (client id/secret, no refresh token) is merged
 * into the token objects that lack one. Social logins (GitHub / Google) use a
 * different refresh service and are rejected.
 */

import type { KiroCredentials } from '../kiro/model/credentials.js';
import type { NewAccount } from './account-pool.js';
import { isBuilderIdStartUrl } from './profiles.js';

export interface ParsedImport {
  accounts: NewAccount[];
  errors: string[];
}

type Flat = Record<string, unknown>;

export function parseImport(text: string, name?: string): ParsedImport {
  const values = parseJsonValues(text);
  const flats: Flat[] = [];
  for (const v of values) collect(v, flats);

  const tokens = flats.filter((f) => str(f.refreshToken));
  const registrations = flats.filter(
    (f) => !str(f.refreshToken) && str(f.clientId) && str(f.clientSecret),
  );
  const errors: string[] = [];
  if (tokens.length === 0) {
    errors.push('no refreshToken / refresh_token field found in the pasted text');
    return { accounts: [], errors };
  }

  const accounts: NewAccount[] = [];
  tokens.forEach((t, i) => {
    const label = tokens.length > 1 ? `entry ${i + 1}` : 'credential';
    const reg = !str(t.clientId) && registrations.length === 1 ? registrations[0] : undefined;
    const merged: Flat = reg
      ? { ...reg, ...t, clientId: reg.clientId, clientSecret: reg.clientSecret }
      : t;

    const authMethod = (str(merged.authMethod) ?? '').toLowerCase();
    const provider = (str(merged.provider) ?? '').toLowerCase();
    if (authMethod === 'social' || provider === 'google' || provider === 'github') {
      errors.push(
        `${label}: social login (GitHub / Google) accounts are not supported; use Builder ID or IAM Identity Center`,
      );
      return;
    }
    const clientId = str(merged.clientId);
    const clientSecret = str(merged.clientSecret);
    if (!clientId || !clientSecret) {
      errors.push(`${label}: missing clientId / clientSecret (paste the device registration too)`);
      return;
    }
    const startUrl = str(merged.startUrl);
    const region = str(merged.region);
    const credentials: KiroCredentials = {
      refreshToken: str(merged.refreshToken),
      accessToken: str(merged.accessToken),
      expiresAt: normalizeExpiry(merged.expiresAt),
      clientId,
      clientSecret,
      region,
      authRegion: str(merged.authRegion),
      apiRegion: str(merged.apiRegion),
      profileArn: str(merged.profileArn),
    };
    accounts.push({
      name:
        tokens.length > 1
          ? (str(merged.name) ?? str(merged.email) ?? undefined)
          : (name ?? str(merged.name) ?? str(merged.email)),
      source: 'import',
      startUrl: startUrl && !isBuilderIdStartUrl(startUrl) ? startUrl : undefined,
      credentials,
    });
  });
  return { accounts, errors };
}

function parseJsonValues(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // Several objects pasted one after another: `{...}\n{...}`.
    try {
      return [JSON.parse(`[${trimmed.replace(/}\s*,?\s*{/g, '},{')}]`)];
    } catch {
      throw new Error('pasted text is not valid JSON');
    }
  }
}

function collect(v: unknown, out: Flat[]): void {
  if (Array.isArray(v)) {
    for (const item of v) collect(item, out);
    return;
  }
  if (!v || typeof v !== 'object') return;
  const obj = camelize(v as Record<string, unknown>);
  if (Array.isArray(obj.accounts)) {
    collect(obj.accounts, out);
    return;
  }
  const inner = obj.credentials;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    const { credentials: _drop, ...outer } = obj;
    out.push({ ...outer, ...camelize(inner as Record<string, unknown>) });
    return;
  }
  out.push(obj);
}

function camelize(o: Record<string, unknown>): Flat {
  const out: Flat = {};
  for (const [k, val] of Object.entries(o)) {
    out[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = val;
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function normalizeExpiry(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
