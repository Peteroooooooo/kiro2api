import type { UsageFinishEvent } from '@kiro2claude/plugin-api';
import { UsageFinishEventImpl } from '../plugin-host/index.js';
import type { RequestLogUsage } from '../shared/request-log.js';

/**
 * Token breakdown for the request log, read after every plugin hook has run
 * (the hook is registered last). The derived plugin splits the upstream
 * context into uncached input / cache read / cache write via
 * `overrideStandardField`; without those overrides (no credits reported) the
 * raw upstream count stands in as input and the cache fields are 0.
 */
export function requestLogUsage(event: UsageFinishEvent): RequestLogUsage {
  const overrides = event instanceof UsageFinishEventImpl ? event.getOverrides() : undefined;
  const contextTokens = event.getMeta<number>('kiro.inputTokens') ?? 0;
  return {
    inputTokens: overrides?.get('input_tokens') ?? contextTokens,
    outputTokens:
      overrides?.get('output_tokens') ?? event.getMeta<number>('kiro.outputTokens') ?? 0,
    cacheReadTokens: overrides?.get('cache_read_input_tokens') ?? 0,
    cacheWriteTokens: overrides?.get('cache_creation_input_tokens') ?? 0,
    contextTokens,
    credits: event.getMeta<number>('kiro.creditsUsed'),
    meteringLost: event.getMeta<boolean>('kiro.meteringMissing') === true,
  };
}
