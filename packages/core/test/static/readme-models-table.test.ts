/**
 * 守卫:README「支持的模型」表与运行时一致。
 *
 * 那张表是给使用者看的手写副本(模型 ID / 上下文 / reasoning 类型),加模型、上游改窗口时最容易
 * 漏改且不会报错。这里按与线上相同的判定逐行核对:ID 集合 = catalog 里非 `-thinking` 的条目,
 * 上下文 = `getContextWindowSize`(GPT 未调 `initGptContextWindow`,即默认窗口),reasoning 类型由
 * `usesNativeReasoning` / `isGptModelId` / `effectiveThinking` 推出。
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
const README = readFileSync(join(HERE, '..', '..', '..', '..', 'README.md'), 'utf8');

/** `## 支持的模型` 表的数据行 → 每个 ID 一条 [id, 上下文, reasoning]。 */
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
  if (isGptModelId(upstreamId)) return '原生,不透明';
  return effectiveThinking({ type: 'disabled' }, upstreamId)?.type === 'adaptive'
    ? '原生,常开'
    : '原生';
}

const baseIds = MODELS.map(({ id }) => id).filter((id) => !id.endsWith('-thinking'));

describe('README「支持的模型」↔ 运行时', () => {
  it('ID 集合与 catalog(不含 -thinking 变体)一致', () => {
    expect(
      readmeRows()
        .map(([id]) => id)
        .sort(),
    ).toEqual([...baseIds].sort());
  });

  it('上下文与 reasoning 类型逐行与运行时判定一致', () => {
    for (const [id, context, reasoning] of readmeRows()) {
      expect(context, id).toBe(contextCell(getContextWindowSize(id)));
      expect(reasoning, id).toBe(reasoningCell(mapModel(id) as string));
    }
  });

  it('每个 Claude 模型都有 -thinking 变体(README 的说法)', () => {
    const all = new Set(MODELS.map(({ id }) => id));
    for (const id of baseIds.filter((id) => !isGptModelId(id))) {
      expect(all.has(`${id}-thinking`), id).toBe(true);
    }
  });
});
