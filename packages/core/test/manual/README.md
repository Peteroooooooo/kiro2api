# 手工探针与检测器

非 CI、vitest 不收(唯一例外 `live-conversation-provider.test.ts`)。「计费」列为「是」的打真实上游。默认测试模型 `claude-opus-5`(`_harness.mjs` 的 `CLAUDE_MODEL`)。起本地服务器的脚本跑完要 `pkill` 掉 tsx 子进程:kill pnpm 包装进程杀不掉它,旧代码会继续占端口。

| 脚本 | 计费 | 用途 |
|---|---|---|
| `_harness.mjs` | - | 共用件:env / 发请求 / 解 SSE / 两套协议不变量 / 汇总退出码;新脚本从这里拿 |
| `_real-provider.ts` / `_marker-png.mjs` | - | 共用件:直打上游的 provider + token manager / 确定性点阵数字图 |
| `kiro-cli-capture-proxy.mjs` | 是 | 录 kiro-cli `chat --v3` 与上游之间的流量(请求脱敏、响应原始帧),`KIRO_KAS_ENDPOINT` / `KIRO_KAS_CONTROL_PLANE_ENDPOINT` 指过来 |
| `reasoning-roundtrip-live.mjs` | 是 | 走网关的原生 reasoning 验收;**改 thinking / effort 相关 converter 必跑** |
| `reasoning-wire-probe.ts` | 是 | 直打上游:effort 放法 × thinking × 顶层 systemPrompt × history `reasoningContent` |
| `kiro-cli-probe.ts` | - | 伪造 event-stream 反向驱动真实 kiro-cli:工具执行 / 重试策略 / 无尾帧 EOF |
| `protocol-integrity.mjs` / `backpressure-integrity.mjs` / `concurrency-integrity.mjs` | - | 流式完整性:协议不变量 / 慢客户端背压 / 并发号段隔离 |
| `opus5-effort-matrix.mjs` / `gpt-tool-matrix.mjs` | 是 | 点验矩阵:Opus 5 effort × 工具 / 图片 / 搜索;GPT 工具往返 × 协议 × 流式 |
| `conversation-fault-server.ts` | `live-*` 场景 | 会话完整性故障服务器:真实网关 + 脚本化上游,按场景注入故障 |
| `claude-conversation-probe.mjs` / `codex-conversation-probe.mjs` | - | 真实 CLI 三轮持久会话 + Docker 工作区文件任务 |
| `empty-cli-server.ts` + `claude-empty-probe.mjs` / `codex-empty-probe.mjs` | - | 空响应场景 × 两款真实 CLI |
| `live-coding-conversation.mjs` / `codex-live-coding-conversation.mjs` | 是 | 真实模型三轮编码会话,`K2C_LIVE_MAX_CALLS` 调预算 |
| `claude-unicode-input-probe.mjs` | - | Claude Code 客户端侧 Unicode 转义改写复现(本地假 Anthropic 服务),见 README「已知限制」 |
| `multi-image-attribution-probe.mjs` / `multi-image-cli-probe.mjs` | 是 | 多图归属:API 直打 / Docker 真 CLI |
| `replay-conversation-history.ts` / `audit-conversation-fixes.mjs` | - | 重放录得请求验证历史保留 / 审计探针产物 |
| `replay-content-preservation.ts` | - | 录得的真实 Claude Code 请求过当前 `convertRequest`,核对客户端文本是否上 wire;**改 converter 必跑** |
| `session-isolation-live.mjs` | 是 | 同会话键下新会话不串、缓存命中、推理信封回传 |
| `session-concurrency-live.mjs` | 是 | 同会话键下并发在途的串话检测(含两款 CLI 的 subagent 形态) |
| `cache-scope-probe.ts` | 是 | 用 credits 反推缓存作用域(`K2C_MODEL` 换模型) |
| `claude-rate-probe.ts` | 是 | 新 Claude 模型接入 derived 前的标定(`K2C_MODELS`),见 PITFALLS「支持哪些模型」 |
| `gpt-cache-derive-live.mjs` | 是 | 走本地网关验 GPT 缓存反演,见 PITFALLS「GPT credit 锚定与缓存反演」 |
| `inserted-content-live.mjs` | 是 | 中途插入内容的各种客户端形态是否到达模型 |
| `codex-subagent-{probe,lifecycle}-server.ts` | - | Codex multi-agent v2 路由受理 / 生命周期矩阵,命令行见 `tools/codex/README.md` |
