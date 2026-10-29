/**
 * 守卫:README「支持的模型」表与运行时一致。
 *
 * 那张表是给使用者看的手写副本(模型 ID / 上下文 / 思考),加模型、上游改窗口时最容易漏改且不会报错。
 * 这里按与线上相同的判定逐行核对:ID 集合 = catalog,上下文 = `getContextWindowSize`(GPT 未调
 * `initGptContextWindow`,即默认窗口),思考一栏由 `usesNativeReasoning` / `isGptModelId` /
 * `effectiveThinking` 推出。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  effectiveThinking,
  getContextWindowSize,
  isGptModelId,
  mapModel,
  usesNativeReasoning,
} from '../../src/claude/converter.js';
import { MODELS } from '../../src/claude/models-catalog.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const README = readFileSync(join(HERE, '..', '..', '..', '..', 'README.md'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** `## 支持的模型` 表的数据行 → 每个 ID 一条 [id, 上下文, 思考]。 */
function readmeRows(): Array<[string, string, string]> {
  const section = README.split('\n## 支持的模型\n')[1]?.split('\n## ')[0] ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => {
      const [ids = '', context = '', reasoning = ''] = line
        .split('|')
        .slice(1)
        .map((c) => c.trim());
      return [...ids.matchAll(/`([^`]+)`/g)].map(
        ([, id]) => [id, context, reasoning] as [string, string, string],
      );
    });
}

function contextCell(tokens: number): string {
  return tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M` : `${tokens / 1_000}K`;
}

function reasoningCell(upstreamId: string): string {
  if (!usesNativeReasoning(upstreamId)) return '无';
  if (isGptModelId(upstreamId)) return 'GPT 推理';
  return effectiveThinking({ type: 'disabled' }, upstreamId)?.type === 'disabled'
    ? '可开可关'
    : '常开';
}

describe('README「支持的模型」↔ 运行时', () => {
  it('ID 集合与 catalog 一致', () => {
    expect(
      readmeRows()
        .map(([id]) => id)
        .sort(),
    ).toEqual(MODELS.map(({ id }) => id).sort());
  });

  it('上下文与思考一栏逐行与运行时判定一致', () => {
    for (const [id, context, reasoning] of readmeRows()) {
      expect(context, id).toBe(contextCell(getContextWindowSize(id)));
      expect(reasoning, id).toBe(reasoningCell(mapModel(id) as string));
    }
  });

  it('catalog 不再列 -thinking 变体(思考是参数,不是模型)', () => {
    expect(MODELS.filter(({ id }) => id.endsWith('-thinking'))).toEqual([]);
  });
});
