import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  entryFromDraft,
  type NewRequestLogEntry,
  RequestLogStore,
} from '../../src/request-log/store.js';
import type { RequestLogDraft } from '../../src/shared/request-log.js';

function entry(over: Partial<NewRequestLogEntry> = {}): NewRequestLogEntry {
  return {
    ts: 1_000,
    reqId: 'aaaa0001',
    method: 'POST',
    path: '/claude/v1/messages',
    model: 'claude-opus-5-5',
    stream: true,
    status: 200,
    durationMs: 1200,
    ttftMs: 300,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    contextTokens: 1050,
    credits: 0.2,
    meteringLost: false,
    emptyAttempts: 0,
    clientDisconnected: false,
    accountId: 'acc1',
    accountName: '主号',
    clientIp: '10.0.0.1',
    userAgent: 'claude-cli/2.1.0',
    ...over,
  };
}

describe('RequestLogStore', () => {
  let dir: string;
  let store: RequestLogStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlog-'));
    store = new RequestLogStore(path.join(dir, 'nested', 'requests.db'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips every field, newest first', () => {
    store.insert(entry({ ts: 1_000, reqId: 'old' }));
    store.insert(
      entry({
        ts: 2_000,
        reqId: 'new',
        thinking: 'adaptive',
        effort: 'high',
        accountsTried: ['备用', '主号'],
        toolNames: ['Bash', 'Read'],
        stopReason: 'tool_use',
        errorType: 'api_error',
        errorMessage: 'msg',
        errorDetail: 'detail',
        meteringLost: true,
        clientDisconnected: true,
        emptyAttempts: 2,
      }),
    );
    const { total, items } = store.list({}, 10, 0);
    expect(total).toBe(2);
    expect(items.map((i) => i.reqId)).toEqual(['new', 'old']);
    const { id, ...rest } = items[0] ?? { id: 0 };
    expect(id).toBeGreaterThan(0);
    expect(rest).toEqual(
      entry({
        ts: 2_000,
        reqId: 'new',
        thinking: 'adaptive',
        effort: 'high',
        accountsTried: ['备用', '主号'],
        toolNames: ['Bash', 'Read'],
        stopReason: 'tool_use',
        errorType: 'api_error',
        errorMessage: 'msg',
        errorDetail: 'detail',
        meteringLost: true,
        clientDisconnected: true,
        emptyAttempts: 2,
      }),
    );
  });

  it('filters by time, account, model, status and search text, and pages', () => {
    store.insert(entry({ ts: 1_000, reqId: 'r1', accountId: 'a', model: 'm1' }));
    store.insert(entry({ ts: 2_000, reqId: 'r2', accountId: 'b', model: 'm1', status: 429 }));
    store.insert(entry({ ts: 3_000, reqId: 'r3', accountId: 'a', model: 'm2', errorType: 'x' }));
    store.insert(
      entry({ ts: 4_000, reqId: 'r4', accountId: 'a', model: 'm2', userAgent: 'codex_100%' }),
    );

    const ids = (f: Parameters<RequestLogStore['list']>[0]) =>
      store.list(f, 10, 0).items.map((i) => i.reqId);
    expect(ids({ since: 2_000, until: 4_000 })).toEqual(['r3', 'r2']);
    expect(ids({ accountId: 'a' })).toEqual(['r4', 'r3', 'r1']);
    expect(ids({ model: 'm1' })).toEqual(['r2', 'r1']);
    expect(ids({ status: 'ok' })).toEqual(['r4', 'r1']);
    expect(ids({ status: 'error' })).toEqual(['r3', 'r2']);
    expect(ids({ q: 'r3' })).toEqual(['r3']);
    // LIKE wildcards in the search text are literal
    expect(ids({ q: '100%' })).toEqual(['r4']);
    expect(ids({ q: '1%0' })).toEqual([]);

    const page = store.list({}, 2, 2);
    expect(page.total).toBe(4);
    expect(page.items.map((i) => i.reqId)).toEqual(['r2', 'r1']);
  });

  it('summarises tokens and credits, timing averages exclude failures', () => {
    store.insert(entry({ durationMs: 1000, ttftMs: 100 }));
    store.insert(entry({ durationMs: 3000, ttftMs: 300 }));
    store.insert(
      entry({
        status: 503,
        durationMs: 99_999,
        ttftMs: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        credits: undefined,
      }),
    );
    expect(store.summary({})).toEqual({
      requests: 3,
      failed: 1,
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 1800,
      cacheWriteTokens: 0,
      credits: expect.closeTo(0.4, 10),
      avgDurationMs: 2000,
      avgTtftMs: 200,
    });
    expect(store.summary({ since: 5_000 })).toMatchObject({
      requests: 0,
      failed: 0,
      credits: 0,
      avgDurationMs: undefined,
    });
  });

  it('facets list models and the latest name of each account', () => {
    store.insert(entry({ accountId: 'a', accountName: '旧名', model: 'm2' }));
    store.insert(entry({ accountId: 'a', accountName: '新名', model: 'm1' }));
    store.insert(entry({ accountId: undefined, accountName: undefined, model: undefined }));
    expect(store.facets()).toEqual({
      models: ['m1', 'm2'],
      accounts: [{ id: 'a', name: '新名' }],
    });
  });

  it('prune removes rows older than the cutoff', () => {
    store.insert(entry({ ts: 1_000 }));
    store.insert(entry({ ts: 5_000 }));
    expect(store.prune(2_000)).toBe(1);
    expect(store.list({}, 10, 0).items.map((i) => i.ts)).toEqual([5_000]);
  });
});

describe('entryFromDraft', () => {
  const base: RequestLogDraft = {
    reqId: 'r',
    startedAt: 10_000,
    method: 'POST',
    path: '/claude/v1/messages',
    clientIp: '1.2.3.4',
    stream: true,
    accountIds: [],
    handlerDone: true,
    finishedAt: 12_500,
    statusCode: 200,
  };

  it('derives durations and resolves account names', () => {
    const e = entryFromDraft(
      { ...base, firstTokenAt: 10_400, accountIds: ['a', 'b', 'b'] },
      (id) => ({ a: 'Alpha' })[id],
    );
    expect(e.durationMs).toBe(2_500);
    expect(e.ttftMs).toBe(400);
    expect(e.accountId).toBe('b');
    // unknown ids fall back to the id itself
    expect(e.accountName).toBe('b');
    expect(e.accountsTried).toEqual(['Alpha', 'b']);
  });

  it('omits accountsTried when only one account served the request', () => {
    const e = entryFromDraft({ ...base, accountIds: ['a', 'a'] }, () => 'Alpha');
    expect(e.accountName).toBe('Alpha');
    expect(e.accountsTried).toBeUndefined();
    expect(e.ttftMs).toBeUndefined();
  });
});
