/**
 * Request log end to end: the real Claude routes on a listening server, the
 * same hook wiring as index.ts (ALS onRequest, error-body onSend, request-log
 * usage hook registered after the plugins), a stub upstream. Each case checks
 * the row handed to the sink.
 */

import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { entryFromDraft, type NewRequestLogEntry } from '../../src/request-log/store.js';
import { requestLogUsage } from '../../src/request-log/usage.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { requestContextStorage } from '../../src/shared/request-context.js';
import {
  noteErrorResponseBody,
  noteRequestLog,
  setRequestLogSink,
} from '../../src/shared/request-log.js';
import {
  buildAssistantResponseFrame,
  buildMetadataFrame,
  buildMeteringFrame,
  framesWithMetering,
} from '../helpers/event-stream.js';

const API_KEY = 'test-key';
const METERING = { unit: 'credit', unitPlural: 'credits', usage: 0.25 };

function response(data: unknown): AxiosResponse {
  return {
    data: data as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

async function* slowStream(frames: Buffer[], delayMs: number): AsyncIterable<Buffer> {
  for (const f of frames) {
    yield f;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

type Upstream = Partial<Pick<KiroProvider, 'callApi' | 'callApiStream'>>;

function fakeDerived(event: UsageFinishEvent): void {
  if (event.getMeta<number>('kiro.creditsUsed') == null) return;
  event.overrideStandardField('input_tokens', 10, 'test');
  event.overrideStandardField('cache_read_input_tokens', 80, 'test');
  event.overrideStandardField('cache_creation_input_tokens', 5, 'test');
}

let app: FastifyInstance | undefined;
let entries: NewRequestLogEntry[] = [];

async function start(upstream: Upstream): Promise<string> {
  entries = [];
  setRequestLogSink((draft) => entries.push(entryFromDraft(draft, (id) => `name-${id}`)));
  app = Fastify({ logger: false });
  const hookBus = new HookBus();
  hookBus.registerUsageFinish('derived', fakeDerived);
  hookBus.registerUsageFinish('core:request-log', (event) => {
    noteRequestLog({ usage: requestLogUsage(event) });
  });
  app.addHook('onRequest', (_request, _reply, done) => {
    requestContextStorage.run({ reqId: 'req00001', startTime: Date.now() }, done);
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (reply.statusCode >= 400 && typeof payload === 'string') noteErrorResponseBody(payload);
    done(null, payload);
  });
  const frames = framesWithMetering(METERING, 'hello');
  const provider = {
    callApi: async () => response(Buffer.concat(frames)),
    callApiStream: async () => response(slowStream(frames, 0)),
    ...upstream,
  } as unknown as KiroProvider;
  await app.register(
    async (instance) =>
      registerClaudeRoutes(instance, {
        apiKey: API_KEY,
        kiroProvider: provider,
        extractThinking: false,
        identityOverride: false,
        rejectUnsupportedDocuments: false,
        toolDescriptionMaxLen: 10_000,
        abortUpstreamOnDisconnect: false,
        emptyStreamRetries: 0,
        toolCallTextRescue: false,
        hookBus,
      }),
    { prefix: '/claude/v1' },
  );
  return app.listen({ host: '127.0.0.1', port: 0 });
}

function post(base: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/claude/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'user-agent': 'claude-cli/9.9.9 (test)',
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function messages(stream: boolean, extra: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    stream,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
  };
}

async function oneEntry(): Promise<NewRequestLogEntry> {
  await vi.waitFor(() => expect(entries).toHaveLength(1));
  return entries[0] as NewRequestLogEntry;
}

afterEach(async () => {
  setRequestLogSink(undefined);
  await app?.close();
  app = undefined;
});

describe('request log end to end', () => {
  it('streamed success: usage, timing, reasoning, stop reason, client', async () => {
    const base = await start({});
    const res = await post(base, messages(true, { output_config: { effort: 'low' } }));
    expect(res.status).toBe(200);
    await res.text();
    const e = await oneEntry();
    expect(e).toMatchObject({
      reqId: 'req00001',
      method: 'POST',
      path: '/claude/v1/messages',
      model: 'claude-opus-5-5',
      stream: true,
      thinking: 'adaptive',
      effort: 'low',
      status: 200,
      stopReason: 'end_turn',
      inputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
      credits: 0.25,
      meteringLost: false,
      clientDisconnected: false,
      emptyAttempts: 0,
      clientIp: '127.0.0.1',
      userAgent: 'claude-cli/9.9.9 (test)',
    });
    expect(e.outputTokens).toBeGreaterThan(0);
    expect(e.ttftMs).toBeGreaterThanOrEqual(0);
    expect(e.durationMs).toBeGreaterThanOrEqual(e.ttftMs ?? 0);
  });

  it('non-stream success records the stop reason and no first-token time', async () => {
    const base = await start({});
    const res = await post(base, messages(false, { thinking: { type: 'disabled' } }));
    expect(res.status).toBe(200);
    const e = await oneEntry();
    expect(e).toMatchObject({ stream: false, status: 200, stopReason: 'end_turn', credits: 0.25 });
    expect(e.ttftMs).toBeUndefined();
  });

  it('upstream rejection: status, neutral error and the internal cause', async () => {
    const base = await start({
      callApiStream: async () => {
        throw new ProviderError(
          { kind: 'rate_limited', status: 429, retryAfterSeconds: 7 },
          'slow down',
        );
      },
    });
    const res = await post(base, messages(true));
    expect(res.status).toBe(429);
    const e = await oneEntry();
    expect(e.status).toBe(429);
    expect(e.errorType).toBe('rate_limit_error');
    expect(e.errorDetail).toContain('rate_limited');
    expect(e.inputTokens).toBeUndefined();
  });

  it('request validation failure is logged from the error body', async () => {
    const base = await start({});
    const res = await post(base, { model: 'claude-opus-5-5', messages: 'nope' });
    expect(res.status).toBe(400);
    const e = await oneEntry();
    expect(e).toMatchObject({ status: 400, errorType: 'invalid_request_error' });
  });

  it('unauthenticated requests are not logged', async () => {
    const base = await start({});
    const res = await fetch(`${base}/claude/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages(false)),
    });
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    expect(entries).toHaveLength(0);
  });

  it('client disconnect mid-stream: written once the drain bills', async () => {
    const frames = [
      buildAssistantResponseFrame('part one '),
      buildAssistantResponseFrame('part two '),
      buildAssistantResponseFrame('part three'),
      buildMeteringFrame(METERING),
      buildMetadataFrame(),
    ];
    const base = await start({ callApiStream: async () => response(slowStream(frames, 80)) });
    const abort = new AbortController();
    const res = await post(base, messages(true), { signal: abort.signal });
    const reader = res.body?.getReader();
    await reader?.read();
    abort.abort();
    const e = await oneEntry();
    expect(e.clientDisconnected).toBe(true);
    expect(e.credits).toBe(0.25);
    expect(e.outputTokens).toBeGreaterThan(0);
  });
});
