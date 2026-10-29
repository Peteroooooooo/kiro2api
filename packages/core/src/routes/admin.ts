/**
 * Admin panel for the account pool: `GET /admin` serves the page, and
 * `/admin/api/*` is the JSON API it calls, guarded by the admin key
 * (`x-api-key` or `Authorization: Bearer`). The page itself is public; it
 * holds no data until the browser supplies the key.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { MODELS } from '../claude/models-catalog.js';
import type { AccountPool } from '../pool/account-pool.js';
import type { DeviceLoginManager } from '../pool/device-login.js';
import { parseImport } from '../pool/import-credentials.js';
import { createApiKeyAuthHook } from '../shared/auth-hook.js';
import { ADMIN_PAGE_HTML } from './admin-page.js';

export interface AdminRouteDeps {
  adminKey: string;
  /** Client API key, shown on the page so clients (e.g. New API) can be configured. */
  apiKey: string;
  pool: AccountPool;
  logins: DeviceLoginManager;
}

type IdParams = { Params: { id: string } };

function fail(reply: FastifyReply, status: number, error: unknown): FastifyReply {
  return reply
    .status(status)
    .send({ error: error instanceof Error ? error.message : String(error) });
}

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  return v;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps,
): Promise<void> {
  const { pool, logins } = deps;

  app.get('/', async (_request, reply) => {
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer');
    return ADMIN_PAGE_HTML;
  });

  await app.register(
    async (api) => {
      api.addHook('preHandler', createApiKeyAuthHook(deps.adminKey));
      api.addHook('onSend', async (_request, reply, payload) => {
        reply.header('cache-control', 'no-store');
        return payload;
      });

      api.get('/status', async () => {
        const accounts = pool.list();
        const count = (s: string) => accounts.filter((a) => a.status === s).length;
        return {
          accounts: accounts.length,
          ok: count('ok'),
          cooling: count('cooling'),
          disabled: count('disabled'),
          quota: pool.aggregateQuota(),
        };
      });

      api.get('/connection', async () => ({
        apiKey: deps.apiKey,
        models: MODELS.map((m) => m.id),
      }));

      api.get('/accounts', async () => ({ accounts: pool.list() }));

      api.post<{ Body: { text?: unknown; name?: unknown } }>(
        '/accounts/import',
        async (request, reply) => {
          let parsed: ReturnType<typeof parseImport>;
          try {
            const text = optString(request.body?.text, 'text');
            if (!text) return fail(reply, 400, 'text is required');
            parsed = parseImport(text, optString(request.body?.name, 'name'));
          } catch (e) {
            return fail(reply, 400, e);
          }
          const results = [];
          for (const account of parsed.accounts) {
            results.push(await pool.addAccount(account));
          }
          if (results.length === 0) return fail(reply, 400, parsed.errors.join('; '));
          return { results, errors: parsed.errors };
        },
      );

      api.patch<IdParams & { Body: { name?: unknown; enabled?: unknown } }>(
        '/accounts/:id',
        async (request, reply) => {
          const { name, enabled } = request.body ?? {};
          if (enabled !== undefined && typeof enabled !== 'boolean') {
            return fail(reply, 400, 'enabled must be a boolean');
          }
          let patchName: string | undefined;
          try {
            patchName = optString(name, 'name');
          } catch (e) {
            return fail(reply, 400, e);
          }
          if (!pool.update(request.params.id, { name: patchName, enabled })) {
            return fail(reply, 404, 'account not found');
          }
          return { ok: true };
        },
      );

      api.delete<IdParams>('/accounts/:id', async (request, reply) => {
        if (!pool.has(request.params.id)) return fail(reply, 404, 'account not found');
        if (!pool.remove(request.params.id)) {
          return fail(reply, 400, 'the kiro-cli account comes from SQLite; disable it instead');
        }
        return { ok: true };
      });

      api.post<IdParams>('/accounts/:id/quota', async (request, reply) => {
        if (!pool.has(request.params.id)) return fail(reply, 404, 'account not found');
        try {
          return { quota: await pool.refreshQuota(request.params.id) };
        } catch (e) {
          return fail(reply, 502, e);
        }
      });

      api.post('/accounts/quota', async () => {
        const results = await Promise.all(
          pool.list().map(async (a) => {
            try {
              await pool.refreshQuota(a.id);
              return { id: a.id, ok: true };
            } catch (e) {
              return { id: a.id, ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }),
        );
        return { results };
      });

      api.post<{ Body: { startUrl?: unknown; region?: unknown; name?: unknown } }>(
        '/login/start',
        async (request, reply) => {
          try {
            const body = request.body ?? {};
            return await logins.start({
              startUrl: optString(body.startUrl, 'startUrl'),
              region: optString(body.region, 'region'),
              name: optString(body.name, 'name'),
            });
          } catch (e) {
            return fail(reply, 400, e);
          }
        },
      );

      api.get<IdParams>('/login/:id', async (request, reply) => {
        const session = logins.get(request.params.id);
        return session ?? fail(reply, 404, 'login session not found');
      });

      api.delete<IdParams>('/login/:id', async (request, reply) => {
        return logins.cancel(request.params.id)
          ? { ok: true }
          : fail(reply, 404, 'login session not found');
      });
    },
    { prefix: '/api' },
  );
}
