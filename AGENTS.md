# AGENTS.md

给在此仓库工作的 coding agent(Claude Code / Codex 等)看的**规范与地图**,只给指针不复述。使用者入口见 [README.md](./README.md);踩坑的来龙去脉见 [docs/PITFALLS.md](./docs/PITFALLS.md);插件见 [docs/PLUGIN-DEVELOPMENT.md](./docs/PLUGIN-DEVELOPMENT.md);手工探针见 [packages/core/test/manual/README.md](./packages/core/test/manual/README.md)。

## 项目一句话

把 kiro-cli(Kiro 后端)包装成 Claude + OpenAI 双协议代理:Claude 全系 + GPT-5.6(Sol / Terra / Luna)走**完全相同**的上游,两个协议端点都可用。MIT;内置插件 `metering`(计量)、`derived`(credit 反演)。Node ≥ 22 / TypeScript / ESM NodeNext / Fastify / pnpm workspace。

## Monorepo 边界

```
packages/plugin-api/            契约包:types + abstract base class,0 runtime deps
packages/core/                  gateway runtime:HTTP 路由、plugin loader、token manager
packages/plugin-metering/       注入 usage.kiro_metering
packages/plugin-derived/        反演 Kiro credit → Anthropic token,注入 usage.kiro_derived
packages/examples/echo-plugin/  公开示范 plugin
packages/core/test/manual/      手工探针(非 CI;部分打真实上游计费),清单见其 README
tools/claude-code/ tools/codex/ 两款真实 CLI 的 Docker harness(非 runtime)
docker/Dockerfile               单一发布镜像(core + 两个内置插件)
.github/workflows/              ci.yml 全 workspace lint+typecheck+test;release.yml 发版
```

插件都是普通 npm 包:loader 只扫 core 所在 `node_modules` 第一层(含 `@scope/` 下一层、不递归)里带 `kiro2claude-plugin` keyword 的包,内置与第三方同一机制(契约不加 tier 字段)。

## 架构地图

```
packages/core/src/
├── index.ts            入口;config → login → creds → SingleTokenManager → plugin-host → Fastify → 路由 → discoverPlugins
│                       /api/{claude,openai}/v1 = 去泄漏镜像(preHandler 打 stripPluginUsage 标记)
├── token.ts            count_tokens 本地估算 + 远程回退
├── model/config.ts     Config 契约 + loader;env 名 / 默认值 / 校验在 model/schemas/config-schema.ts
├── shared/             横切层(鉴权 / wire-format errors / logger / paths / reqId-ALS)
├── plugin-host/        插件契约实现:hook-bus / usage-finish-event / capability-registry / loader(keyword 扫描 + 拓扑排序)
├── routes/             HTTP 装配层:claude / openai / kiro / health 四组路由
├── kiro/               上游适配层(token-manager / client-profile / provider / retry-executor / parser);
│                       GetUsageLimits 由 index.ts 适配成 'usage-limits' capability
└── claude/             下游兼容层
    ├── converter.ts          Claude→Kiro 请求(system 折叠、当前轮、thinking / effort 字段)
    ├── stream-handler.ts     流式 handler;deferred commit + 空流有界重试
    ├── non-stream-handler.ts 非流式 handler;判空 / 重试镜像
    ├── non-stream-reduce.ts  reduceKiroResponse:claude & openai 非流式共用
    ├── stream.ts             SSE 状态机;buildClaudeUsagePayload / buildKiroUsageFinishEvent / isMeteringLost 唯一定义点
    ├── empty-capture.ts      空流类型 + 诊断抓包
    ├── tool-call-text.ts     泄漏工具调用的检测 / 救援 / 剥除;头注释 = 全部红线
    ├── stream/legacy-thinking-decoder.ts  legacy `<thinking>` 文法唯一定义点
    ├── tool-use-sequence.ts  tool_use 序列 + `parseCompletedToolInput`(「绝不回退 {}」实施点)
    └── reasoning-envelope.ts Claude 签名 / GPT 推理的往返信封

openai/                 OpenAI 兼容层:语义核心复用 claude,只做协议翻译
├── freeform-tool.ts        `type:"custom"` 工具替身编解码的单一真相源
├── stream-transport.ts / non-stream-transport.ts  chat + responses 共用脚手架
└── responses/          Responses API:converter(input items / additional_tools / namespace 展开)、response-stream、
                        response-nonstream、handlers、types
```

**依赖方向**(不得反向):`shared → kiro → claude → openai → routes → index`。`openai/ → claude/` 靠 review 约束,biome `noRestrictedImports` 只管两个内置插件。

## 找东西去哪里

| 想看 | 真相源 |
|---|---|
| `KIRO2CLAUDE_*` 环境变量 | `model/schemas/config-schema.ts` + `.env.example`;唯一例外 `KIRO2CLAUDE_CLIENT_PROFILE_PATH` 直读 `process.env`(auto-capture 运行期改写,`kiro/client-profile.ts`) |
| Plugin 契约 | `packages/plugin-api/src/types.ts`;`docs/PLUGIN-DEVELOPMENT.md` + `packages/examples/echo-plugin/` |
| 支持哪些模型 / 加模型要同改哪几处 | `claude/models-catalog.ts` + `mapModel()`;同改清单(含 README 模型表)见 PITFALLS「支持哪些模型」 |
| 原生 reasoning / context window / effort | `converter.ts`:`MODELS_WITH_NATIVE_REASONING`、`getContextWindowSize()`、`effectiveThinking()`(上游字段与响应侧 thinking 通道同一判定)→ `buildAdditionalModelRequestFields()` + `resolveEffort()` + `defaultEffort()`;OpenAI 侧 `reasoningConfigFromEffort`;探针 `reasoning-wire-probe.ts`(直打)、`kiro-cli-capture-proxy.mjs`(录 kiro-cli) |
| legacy `<thinking>` 解析 | `legacy-thinking-decoder.ts` 头注释;流式 `processLegacyThinkingItems` 与 `non-stream-reduce.ts` 必须同源 |
| Codex 工具 / freeform 双向 | `openai/responses/converter.ts` `collectTools` + `expandNamespaces`;`openai/freeform-tool.ts`;下行经 `customToolNames` 还原 |
| OpenAI 缓存命中 / 推理往返信封 | `resolveCacheReadTokens`;`claude/reasoning-envelope.ts` |
| GPT 推理(不透明) | `claude/stream/opaque-reasoning.ts` → Messages `redacted_thinking`、Responses `encrypted_content`,Chat 不回传 |
| conversationId / rootConversationId / agentContinuationId / agentMode | `resolveConversationIdentity`(`claude/converter.ts`);Codex 线程 `responsesSession` |
| 身份覆写 | `IDENTITY_OVERRIDE_DIRECTIVE` + `KIRO2CLAUDE_IDENTITY_OVERRIDE`(默认关,原因见该常量头注释) |
| 网关往对话里塞了哪些文本 | `converter.ts` 文件头导出常量 + `prependImageLegend` / `imagePlaceholder`;system 前缀与中途插入见踩坑「注入文本」 |
| 上游 status → 下游 status / 容量不足 / 额度耗尽 | `classifyErrorBody` + `matchQuotaExhausted` + `MODEL_CAPACITY_REASONS`(`kiro/provider-error.ts`)→ `classifyProviderError`(`claude/error-mapper.ts`);`/kiro/usage` 见 `translateUsageError`(`routes/kiro.ts`) |
| 上游 wire(kiro-cli V3 / KAS)/ fixture 升版本 | `fixtures/kiro-cli-profile.json`(`kas` / `shell` 两个身份)+ `kiro/client-profile.ts`;抓包 `scripts/capture-kiro-cli.sh` → commit `fixtures/`;版本号由 `.releaserc.json` 从 fixture 派生 |
| 重试头 | `applyRetryHeaders`(`kiro/retry-executor.ts`)唯一 owner;见 PITFALLS「重试头」;守卫 `test/kiro/retry-headers.test.ts` |
| plugin 注入 `usage` / `kiro.*` meta 键 | `event.addExtension` / `overrideStandardField`;meta 键 = `buildKiroUsageFinishEvent` + `plugin-api/src/types.ts` `getMeta` + PLUGIN-DEVELOPMENT「Meta 键」,**加键同改三处**,守卫 `test/static/usage-meta-contract.test.ts` |
| 上游已扣费但没记账 | `isMeteringLost`(`claude/stream.ts`),估规模前读其头注释的口径偏差 |
| 上游「说完了」还是「说到一半」 | `metadataEvent` 出现过 = 唯一信号(`kiro/model/events/base.ts`);**别用它的 `stopReason`** |
| 流里有没有真实内容 / tool_use 没发完 | `computeHasContent`(`claude/stream.ts`);`StreamContext.hasIncompleteToolUse()`,别退回 `stop_reason === 'tool_use'` |
| 孤儿 tool_use | `synthesizeMissingToolResults`(`claude/converter.ts`)补 isError tool_result,不删 tool_use |
| `/api/*` 怎么剥 plugin 扩展 | `index.ts` 打 `stripPluginUsage` + `resolvePluginUsageExtensions`(`claude/stream.ts`,两协议共用) |
| 链路里仍不能保证的 | README「已知限制」;别拿全绿单测当链路无损的证据 |
| kiro-cli 重试 / web_search 执行位置 / 工具与图片 wire / InputValidationError 排查 | PITFALLS「上游与客户端的实测事实」 |
| 发版 / commit 规范 | `CONTRIBUTING.md`「版本与发布」「提交规范」;`.releaserc.json`、`.gitmessage` |

## 不可违反的规范

### 架构 / 插件边界

- 依赖方向单向;所有 plugin(含内置)**必须**经 `@kiro2claude/plugin-api` 集成,**禁止** import core 内部模块
- 新增路由:core 放 `routes/`,plugin 用 `ctx.app.register(...)`;新增 `KIRO2CLAUDE_*` env:core 进 `config-schema.ts`,plugin 自读 `ctx.env`

### Plugin 契约

- 契约类型是 SemVer 公开 API,破坏性改动 = major bump;不暴露 kiro-specific 类型,用 capability 命名查询
- `addExtension` 只加新键(同名后写覆盖,与 usage 已有字段同名的跳过);改标准字段只能 `overrideStandardField(name, value, reason)`;`kiro.pricedModel` = `mapModel` 后的上游 id
- `apiVersion: '1.x'` 必须匹配 host 主版本;`dependsOn` 拓扑排序,hook 注册顺序 = 调用顺序

### TypeScript / 模块系统

- 根 `tsconfig.base.json` 共享 strict + NodeNext + composite;相对导入**必须**带 `.js`;永远 `import`
- 启动期 I/O 保持同步(`readFileSync`)

### 错误流转

- 对话上游非 2xx → `RetryExecutor` 抛 `ProviderError`;token refresh / GetUsageLimits 非 2xx → `KiroHttpError`;转换失败 → `ConversionError`(`UnsupportedModel` / `EmptyMessages` / `InvalidRole`)→ 400
- `ProviderErrorKind` 新增 variant 由 tsc 强制穷尽:`claude/error-mapper.ts` 用 `assertNever`,`kiro/provider-error.ts` 的 `defaultMessage` 靠结构穷尽(`kiro/` 不能 import `claude/`)
- 408/429/503/504 原样透传(含 Retry-After;声明额度耗尽的 429 除外);500/501/502/505+ 与 401/403 压成 502
- 400 `THINKING_SIGNATURE_INVALID` → `thinking_signature_invalid`:`RetryExecutor` 剥掉全部 `reasoningContent` 重发一次(info 级),再失败 → 400 中性文案
- **例外,先于上条判**:5xx 的 body 点名容量不足 → 503 `overloaded_error`;施加点在 `retry-executor.ts` 的 5xx 分支而**非** `classifyErrorBody`。判别子见 `MODEL_CAPACITY_REASONS` 头注释,原因见 PITFALLS「容量不足的 5xx」
- **额度耗尽**(`matchQuotaExhausted`,先于 429 分支):402 一律算,其它 4xx 只认声明的额度 reason → 402 `billing_error`;**别与上条统一**(两者误判代价相反)。守卫 `test/kiro/provider-error.test.ts` + `test/claude/quota-exhausted-e2e.test.ts`;见 PITFALLS「额度耗尽」

### 响应文案中性化

- 日志可用 `upstream` / `Kiro`;响应 body 只说 `service`;绝不把 `err.message` 或上游 body 拼进响应;新增 mapper case **必须**加 leak-detection 断言
- 同一底线管提交历史,禁写字段见 `CONTRIBUTING.md`「脱敏」

### 日志(`test/static/` 守卫钉住,理由见 PITFALLS「日志四条守卫的理由」)

- **每请求只打一行**:`disableRequestLogging: true`,只留 `index.ts` `onResponse` 那条。守卫 `request-log-single-line.test.ts`
- **业务字段一律 snake_case**(框架自带的 `msg`/`err`/`level`/`time`/`reqId`/`statusCode` 除外)。守卫 `log-field-casing.test.ts`
- **一个指标只有一个 owner**:`capacity_reason` 只在 `kiro/retry-executor.ts` 的 429 与 5xx 分支记。守卫 `log-capacity-reason.test.ts`
- **网关自己造成的结果不记 `error`**:加标志位降 `info`;真实故障仍是 `error`,改豁免须同时写反向守卫

### 代码风格

`throw` + 自定义 `Error` 子类;`T | undefined` 而非 `null`,用 `??` / `?.`;多形态用 discriminated union;异步互斥用手写 `AsyncMutex`;时间戳 `Date.now()` 毫秒;键值集合 `Map`;二进制 `Buffer` + 自维护 offset、默认大端序;JSON 字段 camelCase;配置启动期同步读 `process.env`。

## 高频踩坑陷阱

> 每条 = 红线 + 真相源,长版在 PITFALLS 同名条目或条目里写明的 PITFALLS「…」(前两节与 cachePoint / tool-search marker 两条一句自足)。回指写 `踩坑「关键词」`,改标题两处同步;带守卫的条目改前先跑守卫。

### 运行时基础设施

- **Fastify logger**:用 `loggerInstance: pinoInstance`,不是 `logger:`
- **Parser Result 类型守卫**:用 `'frame' in result`,不是 `result.ok`
- **CRC32 符号位**:`crc-32` 返回有符号 32-bit,必须 `>>> 0`
- **AWS Event Stream 全 big-endian**:`readUInt32BE` / `readInt16BE` / `readBigInt64BE`
- **AsyncMutex 必要性**:JS 单线程,但 `await` 会让出控制权
- **SIGTERM**:Docker 用 `tini` 作 PID 1,`forceCloseConnections: 'idle'` 是优雅关闭关键

### 鉴权 · 凭据 · 构建部署

- **AWS SSO OIDC wire**:Smithy 协议,请求 / 响应都是 camelCase
- **API key 比较**:必须 `crypto.timingSafeEqual`
- **SQLite 凭据不可跨机器**:refresh 可能返回新 refreshToken 写回 SQLite
- **better-sqlite3 跨架构**:Mac → Linux 容器构建必须在 builder 阶段编译

### 请求转换 · 工具(Claude→Kiro)

- **上游 wire 只有 kiro-cli V3(KAS)一套**:target / UA / 头 / body 全取 profile 的 `kas` 身份(GetUsageLimits 走 `shell`),身份是 kiro-cli 交互会话(`origin: KIRO_CLI` 不是 V2 遗留);唯一有意偏离是 system 折叠;别把 V2 的 envState / messageId / REST 路径加回来。守卫 `test/static/kiro-wire-v3.test.ts` + `test/kiro/provider-v3-wire.test.ts`;见 PITFALLS「kiro-cli V3(KAS)的 wire」
- **注入文本**:system 没有 wire 通道,`buildSystemPrefix` → `foldSystemIntoFirstUserMessage` 在 Kiro 消息层拼进首条 user;不造任何 assistant 轮次;中途 `role:system` 只走 `foldSystemMessages`;其它 role 400;OpenAI 侧只提升开头的 system / developer。守卫 `test/static/no-fabricated-turns.test.ts` + `converter.test.ts` system 折叠组
- **core 不发 cachePoint**:Kiro 静默忽略 `cache_control`,`convertTools` 只输出 `{toolSpecification}`
- **convertTools 剥 tool-search marker**:无 `input_schema` 的 marker 上送会 400,`isToolSearchTool()` 丢掉、忽略 `defer_loading`
- **工具调用文本泄漏**:`KIRO2CLAUDE_TOOL_CALL_TEXT_RESCUE` 双向兜底;红线在 `claude/tool-call-text.ts` 头注释,**改前必读**
- **tool description cap**:`KIRO2CLAUDE_TOOL_DESCRIPTION_MAX_LEN` 只截单个畸形 description,总量靠 Kiro 的 context-window 400
- **多图归属只靠顺序**:`canonicalizeToolResultOrder` + `imagePlaceholder` + `prependImageLegend` 三件套缺一不可。守卫 `test/claude/converter-{tool-result-order,image-placeholder,image-legend}.test.ts`

### 流式传输 · 断连 · 空流

- **空流有界重试**:仅 pre-commit、最多 `KIRO2CLAUDE_EMPTY_STREAM_RETRIES` 次;确定性空流单次定案不耗预算,判据 `sawBillableWork()` 不是 `hasContent()`。红线在 `stream-handler.ts` / `stream.ts` / `empty-capture.ts` 头注释
- **截断 tool_use 必须阻止残缺调用到达客户端**:`pendingToolCalls` 收到 `isComplete` 才上 wire;参数解不出 JSON 即协议错误,**绝不回退 `{}`**;`isComplete` 必须是 boolean;Responses 映射 `incomplete`,不可改 `completed`。守卫 `test/claude/truncated-tool-use.test.ts` + `transport-integrity.test.ts`
- **断连计费**:默认 drain 全额计费;`KIRO2CLAUDE_ABORT_UPSTREAM_ON_DISCONNECT` 省 credit 但 `metering_lost` 恒真
- **write 背压不是断连**:`write()` 返 false 只是等 `'drain'`;存活只看 `destroyed` / `writableEnded` / 抛错;`disconnect_source` 别退回单一布尔。守卫 `test/claude/backpressure.test.ts` + `test/static/sse-backpressure-contract.test.ts`
- **legacy thinking 文法**:开标签只认「行首」;文法与终态判定流式 / 非流式必须同源。守卫 `test/claude/legacy-thinking-{decoder,nonstream}.test.ts`
- **原生 reasoning 的空帧**:锁 native 模式,但不打断已开的 thinking 块、不 flush 救援检测器。见 `processReasoningContent` 头注释
- **上游杀卡住的流**:判别子是 token/s 不是总时长;网关无治本手段,缓解 `armDrainGrace`
- **读坏的 body 是失败的响应**:读流异常 / CRC·JSON 解码失败 / 残留半帧走上游错误帧同一路径;缺 Metering 不算损坏,缺 `metadataEvent` 是未完成;损坏的 body 不可当空流蹭重试。守卫 `test/claude/transport-integrity.test.ts` + `test/kiro/parser/decoder.test.ts`
- **帧边界 EOF**:有内容 + 无错误 + 无 `metadataEvent` → `max_tokens`(Responses `incomplete`);fixture 的正常完成必须带尾帧(`completedFrames()`)。守卫 `test/claude/clean-eof-terminal.test.ts` + `conversation-content-integrity.test.ts`

### 多模型 · GPT · OpenAI · Codex

- **GPT 完全相同上游**:唯一差异 `modelId` 与按模型 schema 的 `additionalModelRequestFields`;`processReasoningContent` 把「见过原生帧」与「有内容可 surface」分开记,合并即错
- **GPT context window 随上游漂移**:`input_tokens` = 上游百分比 × `getContextWindowSize()`,上游改窗口只缩放不报错;分母错了直通计费(低报 → Codex 越过 272K 双倍线,高报 → 提前压缩)。默认 `DEFAULT_GPT_CONTEXT_WINDOW`,未放开的账号设 `KIRO2CLAUDE_GPT_CONTEXT_WINDOW=272000`。守卫 `test/claude/reasoning-native.test.ts`
- **OpenAI prompt_tokens**:是输入总量,`openai/` usage 直读 reducer 原始 token、绕过 `buildClaudeUsagePayload`;插件覆写只取 cache_read → `cached_tokens`,别套 `input_tokens` 覆写
- **Codex 只说 Responses**:编码器红线在 `openai/responses/response-stream.ts` 头注释,改前先跑真实 Codex(`tools/codex/`)
- **Codex code mode**:工具在 `input[0]` 的 `additional_tools`,判别只看字段在不在;namespace 展开与 `namespace` 写回见 `expandNamespaces` 头注释;`agent_message` 三类必转(`convertAgentMessage`);freeform 流式须缓冲到 block 结束。守卫 `test/openai/responses/subagent-wire.test.ts` + `test/static/freeform-tool-contract.test.ts`
- **Messages hosted WebSearch**:`websearch.ts` 保留协议与失败语义,同名普通 function 不能被劫持。守卫 `test/claude/websearch-transport.test.ts`
- **Codex 侧无法用 web search**:要支持是新功能,不是转发能解决的
- **thinking / effort 的 wire 规则**:只有 adaptive 语义(`enabled` 归一、`budget_tokens` 丢弃、`between_tools` 归一成 disabled);effort 只看 `output_config.effort`、只发在顶层 `additionalModelRequestFields`;常开模型(`MODELS_THINKING_ALWAYS_ON`)的 `disabled` → adaptive + low;非原生模型不做 thinking 控制;走原生 reasoning 时响应侧 `<thinking>` 扫描禁用(legacy 解码器只对非原生模型保留),请求侧对任何模型都不注入 thinking 提示词前缀;history thinking 只走 `reasoningContent`,带签名才发、无签名丢弃、禁止拼 `<thinking>` 文本;顶层 `systemPrompt` 上游拒收。守卫 `test/static/no-thinking-tag-stitching.test.ts` + `test/claude/converter-reasoning-content.test.ts` + `test/kiro/retry-executor-thinking-signature.test.ts`;见 PITFALLS「原生 reasoning / effort / system 的 wire 真相」
- **会话身份映射到 kiro-cli / 推理往返**:每请求随机 id = GPT 每轮冷价(Claude 缓存按内容);按 KAS 形态映射:会话一个 `sess_` id、用户轮次一个 agentContinuationId、subagent(Codex `thread-id` ≠ key、Claude Code `x-claude-code-agent-id`)= 独立会话 + `rootConversationId` 指父 + 子 agent 的 `agentMode`;Codex `<subagent_notification>` 只在 Responses 适配层并入工具结果;GPT 推理不展示、经信封回传、绑定 modelId,网关不存状态。守卫 `test/claude/converter-conversation-identity.test.ts` + `test/openai/responses/{reasoning-roundtrip,subagent-notification}.test.ts` + `test/claude/opaque-gpt-reasoning.test.ts`;复跑 `test/manual/session-{isolation,concurrency}-live.mjs`
- **derived 反演用 Kiro 的计价,不是 Anthropic 标价**:偏离倍率线的模型进 `KIRO_BILLING`、按 prompt 长度分档的进 `LONG_CONTEXT_TIER`(`plugin-derived/src/derive.ts`);未命中溢价只乘 prompt,`kiro.inputTokens` 含本轮输出;漏填价格表只会静默 `unknown_model`,守卫 `test/static/derived-price-coverage.test.ts`;新模型先跑 `test/manual/claude-rate-probe.ts` 标定
- **GPT credit 锚定与缓存反演**:成本锚定 `credits×0.04`;缓存按 GPT 自己的公式反演(0.1× 缓存价、按 conversationId 命中、超 272K 整单 ×2 即 `GPT_LONG_CONTEXT`),误差在可见输出估算;**绝不给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`**;常数在 `gptCacheDerivedBreakdown` 头注释

### 错误流转 · 容量事件诊断

- **跨模型对照**:「网关报内部错误」先同容器跨模型对照,再看分钟时间轴、请求形状、region / tier;别按主机 / 账号先分桶;有界重试无效,缓解是切模型;日志看 `capacity_reason`

## 测试

- vitest;只有 core 有 `vitest.config.ts`(排除 e2e);pre-commit 强制 `biome check + pnpm -r typecheck + pnpm -r test + markdownlint`
- **e2e 不进 CI**(`packages/core/test/e2e/`,消耗真实 token);`test/` 不在任何 tsconfig 里、vitest 也不做类型检查,改测试要单独 tsc
- **`test/scripts/` 测的是 shell 脚本**:假 `docker` 记录调用参数,不碰本机 `.env`、凭据、镜像
- **默认测试模型 `claude-opus-5-5`**(上游 id `claude-opus-5.5`),只管真打上游的那几层;单测里的 `claude-opus-4-6` 是 fixture 常量,别全局替换
- 固定测试图 `packages/core/test/fixtures/images/`:`test-small.png` 内联;`test-large.png` 超阈值走 tool_result 回传,converter 须提升到 `images`
