# 踩坑陷阱:来龙去脉

[AGENTS.md](../AGENTS.md)「高频踩坑陷阱」每条只留红线与真相源,这里是同名条目的长版:为什么这样定、关键结论、怎么复跑。标题与 AGENTS.md 一一对应,改标题两处同步;数据细节以代码头注释与守卫测试为准。

## 请求转换 · 工具(Claude→Kiro)

### 注入文本

Kiro `conversationState` 只有 user/assistant;`userInputMessageContext.additionalContext` 上游 200 但静默丢弃,system 没有 wire 通道。所以 system 文本 = `buildSystemPrefix`(客户端 system + 可选身份指令,不含 thinking 前缀)→ `foldSystemIntoFirstUserMessage` 在 **Kiro 消息层**拼到首条 user 最前(首轮 = currentMessage,之后 = history 首条 user;图例之后拼);后续 user 轮次原文不动;末尾 user 连串整体 = 当前轮,history 必以 assistant 收尾。

**不造合成轮次**:不加开场 `user: system / assistant: "I will follow these instructions."`(kiro-cli 自己的形态),也不在末尾补 `assistant: "OK"`。前者会被模型当真实历史引用,后者让同一段对话在下一轮被 `mergeUserMessages` 合并、形态随轮次漂移;两者零收益,数据在 `foldSystemIntoFirstUserMessage` / `buildHistory` 头注释。身份覆写与注入方式无关地不可靠(user 级权重压不过上游系统提示)→ `KIRO2CLAUDE_IDENTITY_OVERRIDE` 默认关,见 `IDENTITY_OVERRIDE_DIRECTIVE` 头注释。

**中途插入的内容**:Claude Code 的 `role:system` 消息永远紧跟一条 user(权限模式指令、文件变更提醒、`<total_tokens>` 等),只走 `foldSystemMessages` 折进相邻 user 轮;assistant 起手的 history 上游接受。同根三条规则:

1. system 前缀在 Kiro 消息层拼,不在 ClaudeMessage 层——后者对字符串与块数组 content 拼出的分隔不一致,≥2 图时图例还会排到 system 前面。
2. 非 user/assistant/system 的 role → 400 `InvalidRole`,不静默丢(丢的就是用户内容)。
3. OpenAI Chat / Responses 只把开头那段 system/developer 提升成 system,对话开始后出现的原位保留——一律提到开头会让中途指令读起来像开场规则。

复跑 `test/manual/replay-content-preservation.ts`(免费)/ `inserted-content-live.mjs`(计费)。

查 wire 字段名看 `aws/amazon-q-developer-cli` 的 Smithy 客户端类型,别对 kiro-cli 二进制 `strings`。顶层 `systemPrompt` 上游未开,见「原生 reasoning / effort / system 的 wire 真相」。

真实 CLI 验收要点:长会话阶段超时放到 60 分钟(上游慢时短窗口超时不是转换层问题);headless 验 AskUserQuestion 走 `--permission-prompt-tool stdio` 的 `can_use_tool` 控制消息;Claude Code headless 的 init 工具清单本身不含 Glob / Grep / TodoWrite,别当网关问题。

### 工具调用文本泄漏

上游解析偶发失败 → 工具调用块以纯文本掉进响应,留在历史会被模型模仿、同会话复发。`KIRO2CLAUDE_TOOL_CALL_TEXT_RESCUE`(默认开)双向兜底:响应侧解析回真 tool_use、请求侧剥历史泄漏块。红线在 `claude/tool-call-text.ts` 头注释。别用 prompt 指令治它(已证伪)。

### tool description cap

Kiro 对单个 description 无字符硬上限,真限制是 context window(总量撑爆报 400 "Context window is full")。`KIRO2CLAUDE_TOOL_DESCRIPTION_MAX_LEN`(默认 32768)只截畸形超大 description,覆盖已知最大合法工具;总量保护交给 Kiro 的 400。

### 多图归属只靠顺序

Kiro wire 只有消息级 `images[]`;`toolResults[].content` 塞 `{image}` 上游 200 但静默丢弃。tool_result 里的图提升到 `images[]` 后,归属只剩位置:

1. 并行图片工具回执反序时,模型按 tool_use 顺序对应 `images[i]` → `canonicalizeToolResultOrder` 按 tool_use 顺序重排 tool_result 块(只动 tool_result、只在已占槽位间动;连续 user 连串是一轮,同走 `processMessageRun`)。
2. 多图直接放 user 消息并在正文写明顺序时,上游保序、模型数得清。
3. 多个各含一张图的 tool_result(Claude Code 并行 Read 形态)只靠占位符会系统性错位,`content` 开头加一行图例后全对 → `prependImageLegend`:≥2 张图且至少一张来自 tool_result 时前置 `[Attached images, in order: image k = …]`,tool_result 内占位符为 `[image k attached to this message]`。

图例只复述 wire 上已有的事实(序号、tool_use id、调用输入、图前路径),不是指令;单图或图全来自用户时不加。「GPT 把两张相同图数成 1 张」是模型判断,记在 README「已知限制」;点阵 OCR 误读是模型噪声。探针 `multi-image-attribution-probe.mjs` + `multi-image-cli-probe.mjs`。

## 流式传输 · 断连 · 空流

### 空流有界重试

上游偶发「200 OK + 零内容帧」,客户端无法与真实过载区分。仅 pre-commit(未写任何字节)重发,最多 `KIRO2CLAUDE_EMPTY_STREAM_RETRIES`(默认 2)次。确定性空流单次定案、不耗预算(重发只会同样失败):`max_tokens` / `model_context_window_exceeded` / 截断 tool_use / 已开工后的上游 Error·Exception 帧;零帧拒绝(未开工)属瞬时故障、走重试。判据用 `sawBillableWork()` 不是 `hasContent()`——GPT 加密 reasoning 计费但不 surface。`selectEmptyUpstreamMessage` 的 `deterministic` 参数必须显式传。新增判空分支先问「是不是内容绑定的」,是则加进排除列表。红线在 `stream-handler.ts` / `non-stream-handler.ts` / `stream.ts` / `empty-capture.ts` 头注释;不明空流用 `KIRO2CLAUDE_CAPTURE_EMPTY_DIR` 抓包,别盲改 converter。

### 截断 tool_use 必须阻止残缺调用到达客户端

上游偶发宣告工具并发出 input 分片,却未发 `isComplete` 就断流。只改 `stop_reason=max_tokens` 不够:客户端先解析已关闭的工具块、后看终态,仍报 `InputValidationError`。防线落在协议时序上:`stream.ts` 的 `pendingToolCalls` 按 id 缓存参数,收到 `isComplete` 才分配 block index 并发 start/delta/stop;未完成调用不上 wire、不占索引,交错调用按完成顺序发出。非流式 `non-stream-reduce.ts` 同样只保留完成调用。

参数只有两种合法归宿:普通工具经 `parseCompletedToolInput` 必须解出 JSON 对象,失败即协议错误,**绝不回退 `{}`**(那是静默换一个动作);只有 Responses `customToolNames` 的 freeform 工具保留裸文本(编解码由 `freeform-tool.ts` 独占)。解码边界(`kiro/model/events/base.ts`)校验 name/id/input 类型,`isComplete` 必须是 boolean(字符串 `"false"` 是 truthy);`ToolUseSequence` 拒绝中途改名与完成后复用 id。终态:零 input 空壳 → 确定性空流(`hasIncompleteToolUse()`);已有其它内容 → 丢弃未完成调用、保留文本,终态 `max_tokens`。Responses 映射 `incomplete` + `max_output_tokens`,不可改 `completed`。网关自己 abort 造成的截断由 `ctx.gatewayTruncatedUpstream` 打标降 info。

### 断连计费

客户端断连后默认 drain 上游到 EOF 拿尾帧 Metering,全额计费。`KIRO2CLAUDE_ABORT_UPSTREAM_ON_DISCONNECT`(默认 false)开启后断连主动 abort 上游,省下断连点后的 credit,代价是拿不到 Metering、记账偏低;仅 Claude 端 stream,`drained_after_disconnect` 观测。它让 `metering_lost` 在每次断连时为真(口径见 `isMeteringLost` 头注释)。

### write 背压不是断连

`stream.write()` 返 `false` = 缓冲超 highWaterMark、应等 `'drain'`,socket 健康。误判会停读循环、丢 `message_stop`、上游仍全额计费、日志错记客户端,且专咬最长最贵的响应。存活只看 `destroyed` / `writableEnded` / write 抛错;背压走 `awaitDrain`(带 `close` + 超时兜底);`disconnect_source` 区分 `client_close` / `write_failed`。真相源 `safeWrite` / `awaitDrain` 头注释。

### legacy thinking 文法

`<thinking>` 是 prompt 诱导的文本内协议(产生式见 `legacy-thinking-decoder.ts` 头注释)。开标签只认行首:收紧成「只认响应开头」→ 模型先写句前言再开思考时,思考里起草的 `<invoke>` 被救援物化成真 tool_use(幻影执行);放宽成「任意位置」→ 正文内联提到标签就误开块、一路吞到 EOF。同族三条:① 不按标点 / 引号包裹猜是不是真标签;② 未闭合的块在 EOF 仍归 thinking;③ 文法与终态判定流式 / 非流式必须同源(空块 `<thinking></thinking>` 曾在两条路径得出不同终态)。新增 thinking 分支先把两条路径对拍。

### 原生 reasoning 的空帧

任意 `reasoningContentEvent`(含空 / redacted)都锁 native 模式,作为模型别名漏判时的运行时兜底。两条边界:① 不打断已开的 thinking 块(`hasOpenThinking`),否则剩余私有推理连同字面 `</thinking>` 进可见文本;② 不 flush 泄漏工具调用的救援检测器,否则跨帧候选被截断——GPT 推理帧在这里一律按空帧处理,受害的恰是 GPT。真相源 `processReasoningContent` 头注释。

### 上游杀卡住的流

上游偶发生成中途发泛化 `Exception`(无 `ContextUsage` + `Metering` 尾帧),已 commit 只能转 in-band `error`。判别子是产出速率(token/s)不是总时长。网关无治本手段,post-commit 也无法重试;缓解见 `armDrainGrace`(只在已断连时武装,连接中 idle 只受 axios 720s 约束)。

### 读坏的 body 是失败的响应

三类损坏走与显式上游错误帧同一条终结路径:① 读流异常(`ECONNRESET` / `ERR_STREAM_PREMATURE_CLOSE`,经 `recordStreamReadError`,网关主动取消除外);② 帧 CRC 或已知事件 JSON 解码失败;③ HTTP 正常 EOF 但残留半帧(`EventStreamDecoder.assertComplete()`)。仍继续 drain 取 Metering,但错误确定后不再发出后续工具调用。不算损坏的:Unknown 事件、任意分片切法、缺 Metering(只是漏账);缺 `metadataEvent` 是未完成(见下条)。已知事件只校验正在消费的字段类型。`bodyReadFailed` 是单向标志,后到的错误帧清不掉;`canRetryZeroWorkRejection` 只放行「无损坏 + 零计费工作」的显式拒绝,损坏的 body 不可当空流蹭重试。

### 帧边界 EOF

上游偶发生成中途干净断流,EOF 恰落在帧边界,`assertComplete()` 无半帧可查。若发 `end_turn`,Claude Code 会把半句话当任务完成、不再续接。唯一可判信号:正常完成的响应都以 `metadataEvent → contextUsageEvent → meteringEvent` 收尾(Claude 与 GPT 皆然),缺尾帧的只出现在真实故障或断连中。kiro-cli 自己不做这个判定,网关有意更严格——Claude Code / Codex 对 `max_tokens` / `incomplete` 会续接,对 `end_turn` 只会当完成。所以 **有内容 + 无错误 + 无 `metadataEvent` → `max_tokens`**(Responses → `incomplete` / `max_output_tokens`)。

三条红线:① 只取「出现过」,不用它的 `stopReason`(带工具的响应常报 END_TURN);② 零内容仍归判空 + 有界重试,显式错误帧与读流损坏走 in-band error;③ 已完成的 tool_use 无尾帧也报 `max_tokens`(后面可能还有兄弟调用)。`stream completed` 日志的 `stop_reason` 取终结段之后的值。测试 fixture 的正常完成必须带 `buildMetadataFrame()`(`framesWithMetering` / `completedFrames()` 已含),漏掉 = 在测截断(症状:Codex 每条回复都 `max_output_tokens` 重连)。真实 CLI 复跑 `conversation-fault-server.ts` + `claude-conversation-probe.mjs`(`K2C_PROBE_SCENARIOS=text-eof-once`)。

## 多模型 · GPT · OpenAI · Codex

### GPT 完全相同上游

请求体逐字段相同,唯一差异 `modelId` 与按模型 schema 生成的顶层 `additionalModelRequestFields`(GPT 为 `{reasoning:{effort}}`)——支持新 GPT 变体 = `mapModel` 加分支。响应侧唯一差异:GPT reasoning 走同名 `reasoningContentEvent`,payload 是 `{text:"...", signature}`(文本是占位,推理在签名密文里;`{redactedContent}` 形态仍接收),不进 thinking 通道,只由 `OpaqueReasoningAccumulator` 保留供回传;只有 GPT 推理的响应仍按空流处理。`processReasoningContent` 必须分开记「见过原生帧」(锁 native、关 legacy decoder)与「有内容可 surface」(开 thinking 块):只留后者则 GPT 可见输出里的字面 `<thinking>` 被剥走,只留前者则开出永远空的 thinking 块。

### GPT context window 随上游漂移

`usage.input_tokens` = `contextUsageEvent.contextUsagePercentage` × `getContextWindowSize()`。上游改窗口不报错、只缩放:分母偏小就低报,偏大就高报。默认 `DEFAULT_GPT_CONTEXT_WINDOW`(922000,与 `ListAvailableModels` 的 `maxInputTokens` 一致);还停在 272K 的账号设 `KIRO2CLAUDE_GPT_CONTEXT_WINDOW=272000`。

后果直通计费:Kiro 对 >272K 的请求整单按双倍档计(命中部分也翻倍,见「GPT credit 锚定与缓存反演」)。Codex 不读网关上报的窗口,只拿 `input_tokens` 比内置常量(gpt-5.6-sol 为 272000 × 0.95 = 258,400)决定何时压缩:上报准确时恰在双倍线下方压缩;低报会让真实上下文远超 272K、整段会话落双倍档;高报则提前压缩。这个余量依赖客户端常量不变,客户端若抬到 1M,须在客户端侧 pin `model_context_window`。

判断分母:同一前缀追加已知个数的单 token 词(o200k 下「空格 + the / of / and」各 1 token),Δ百分比 × 分母 = Δtoken,直接解出分母。守卫 `test/claude/reasoning-native.test.ts`;`model_context_window_exceeded` 只看百分比是否到 100,与此常量无关。

### OpenAI prompt_tokens

`buildClaudeUsagePayload` 会应用 derived 插件的 `input_tokens` 覆写(缓存拆分语义),而 OpenAI `prompt_tokens` 是输入总量(含缓存)。所以 `openai/` usage 直接读 reducer 原始 `contextInputTokens ?? inputTokens` 与 `outputTokens`;计费 hook 照跑,`kiro_*` 扩展照常并入(`resolvePluginUsageExtensions`,`/api/*` 剥掉)。插件覆写只取 `cache_read_input_tokens`(`resolveCacheReadTokens`,夹到 `[0, prompt_tokens]`)映射成 `cached_tokens`——它本就是 `prompt_tokens` 的子集,与 derived 的 `input + cache_read == 总量` 同口径;不取的话 Codex 看到的缓存恒为 0。

### Codex 只说 Responses

`wire_api=chat` 在 Codex 0.122+ 移除,必须走 `/openai/v1/responses`。编码器红线在 `openai/responses/response-stream.ts` 头注释(`content_part.added` 先于 `output_text.delta`、done 回填全文、纯工具调用不产空 message、thinking → reasoning summary 惰性开),改编码器前先跑真实 Codex(`tools/codex/`)。推理往返见「推理往返」。

### 会话身份映射到 kiro-cli

GPT 的缓存折扣按 `conversationId` 给(Claude 按内容寻址、与 id 无关),只体现在 credit 上:每请求随机 id 时 GPT 每轮都按冷价,稳定 id 下后续轮次便宜一个量级。网关按 kiro-cli V3(KAS)的会话形态映射,真相源 `resolveConversationIdentity`(`claude/converter.ts`):

| 字段 | KAS 的形态 |
|---|---|
| `conversationId` | 顶层会话 `sess_<uuid>`,一个会话一个,`--resume` 不变;子会话是裸 UUID |
| `rootConversationId` | 主会话等于自己;subagent 指向父会话 |
| `agentContinuationId` | 一个用户轮次一个,轮内工具往返不变;子 agent 结果回到父会话时也不变 |
| 顶层 `agentMode` | 主会话 `vibe`;`invoke_sub_agent` 的子会话为子 agent 的模式(`general-task-execution`) |
| subagent | 独立会话:自己的 id 与 acid + 上面的 root / agentMode;结果以父会话的 tool result 返回 |

- 客户端会话键:Chat / Responses 读 `prompt_cache_key`,Messages 读 `metadata.user_id` 里的 session;都没有时每请求随机。轮次由消息结构推出(`userTurnKey`:不含 tool_result 的 user 连串算一轮,夹在 tool_result 里的 reminder 不算;键 = 序号 + 本轮输入文本,上下文压缩时不复用旧 id)。
- Codex subagent:父子共用 `prompt_cache_key`,线程身份只在 `thread-id` 头里;与 key 不同的 `thread-id` 按 subagent 会话映射(`responsesSession`)。子线程首个请求冷启动是 KAS 形态的必然,别为省它让父子共用 id。
- Claude Code subagent:与主线程共用 session,只多带 `x-claude-code-agent-id`;会话键 = session + agent-id,root 指主线程。客户端原始 session id 不上送。
- Codex 的 `<subagent_notification>` 不开新轮次:它紧跟 `wait` 的工具输出以 user 消息出现,kiro-cli 里同一时刻是 tool result、acid 不变,所以 Responses 适配层把它并进前一条工具结果(只认「整条都是通知 + 前一条是工具输出」);这条约定不进 Messages / Chat 共用的轮次规则。守卫 `test/openai/responses/subagent-notification.test.ts`。
- 缓存作用域:GPT 同一 id 下插入别的对话或旁路请求不挤占已有前缀,换 id 完全不命中;Claude 缓存与 id 无关。所以 Chat 的 `prompt_cache_key` 按 OpenAI 语义直接当缓存分组;Claude Code 的旁路请求(标题生成等)与主线程共用 session id 无影响,网关也不做 kiro-cli 那层标题子会话映射。
- 会话隔离不靠 id:上游不按 conversationId 存历史,同 id 下不带历史的新对话问不出旧内容;并发在途也不串。
- 复跑 `test/manual/session-isolation-live.mjs`、`session-concurrency-live.mjs`、`cache-scope-probe.ts`;守卫 `test/claude/converter-conversation-identity.test.ts` + `test/openai/responses/reasoning-roundtrip.test.ts`。

### 推理往返

KAS 每轮把上一轮推理放回 history 的 `reasoningContent`(GPT 也是 `{reasoningText:{text:"...",signature}}`)。网关把 Kiro 形态装进信封(`claude/reasoning-envelope.ts`),经客户端能原样带回的不透明通道往返:

- **Responses**:客户端声明 `include:["reasoning.encrypted_content"]` 时放在 reasoning item 的 `encrypted_content`(Codex 默认声明);Claude 的签名推理同样走这里。
- **Messages**:GPT 推理以 `redacted_thinking` 块下发(data = 信封),converter 解开还原;外来的 `redacted_thinking` 原样透传,其它模型签发的丢弃。Responses 带回的信封也转成 `redacted_thinking` 交给同一个 converter,还原只有这一处。
- **Chat**:没有对应通道,不回传。
- GPT 推理帧在 tool_use 之后、响应末尾才到,块 / item 只能排在已发内容之后;回程靠 `mergeAssistantMessages` 合并。
- 信封(`k2c.r2.` + JSON)绑定上游 modelId,换模型不回传;认不出的密文一律丢弃。网关不存推理状态。
- GPT 签名上游不校验、回传与否 credit 无差别,回传的意义是对齐 KAS;Claude 签名严格校验(失效走剥离重试)。

### Codex code mode

Codex 按模型名走两套请求形态:认识的名字(`gpt-5.6-sol`)→ code mode,顶层 `tools` 与 `instructions` 都不存在,工具在 `input[0]` 的 `{type:"additional_tools"}` item 里,含 `type:"custom"` 的 freeform 工具;不认识的名字 → fallback 到标准顶层 `tools`。判别只看字段在不在,别按模型名分支;两套都要支持,fixture 在 `test/fixtures/responses/codex-code-mode-request.json` + `codex-code-mode-namespaced-request.json`。code mode 下真实工具(`apply_patch`、`exec_command`)只写在 `exec` 的 description 里,模型调 `exec` 传 JS。

freeform 工具上游无通道 → 包成单 `input` 字符串字段的 JSON 工具(`FREEFORM_TOOL_SCHEMA`),必须同时追加适配说明(原描述写明 "not JSON");工具名经 `customToolNames` 传到响应侧还原 `custom_tool_call`,漏传即错编成 `function_call`。流式须缓冲到 block 结束解出 `input` 再一次性发。编解码单一真相源 `openai/freeform-tool.ts`。Chat 端点刻意未实现 custom 工具(无已知客户端);codec 放在 `openai/` 而非 `openai/responses/`,将来要接只需加一层 wire 适配。

**Codex 0.147+ 把工具再折进一层 namespace**(默认 `functions` 与 subagent 的 `collaboration`),网关就地展开一层:漏展开 = 零工具上送;`collaboration` 展开后必须写回 `namespace` 字段(漏写 = `unsupported call`、模型无限重试)。为何只按名字认 `functions`、为何非递归,见 `expandNamespaces` 头注释。

**multi-agent v2 的 `agent_message` 三类都必须转**(`convertAgentMessage`):`NEW_TASK` 丢 → 子线程空 Payload;`MESSAGE` 丢正文 → 父线程误读成简短确认;`FINAL_ANSWER` 丢 → 父线程看不到子 agent 的答案(最隐蔽:`wait_agent` 的结果只有 `Wait completed.`)。判据与白名单 `PLAINTEXT_BODY_MESSAGE_TYPES` 见该函数头注释;生命周期矩阵见 `tools/codex/README.md` + `test/manual/codex-subagent-{probe,lifecycle}-server.ts`。

### Messages hosted WebSearch

`websearch.ts` 的同一 Message 同时生成 JSON 与 SSE,遵守请求 `stream`;`web_search_tool_result.tool_use_id` 引用同次 `server_tool_use.id`。多轮请求读最后一条 user query。MCP 错误、`isError`、损坏结果按错误返回,429 保留 Retry-After,只有显式 `results:[]` 才算零结果成功。同名 `web_search` 的普通 client function 不能被 MCP 旁路劫持。搜索结果进入模型上下文的唯一通道是这条 Message 的摘要文本(下一轮的 `server_tool_use` / `web_search_tool_result` 在 Kiro 没有对应物、不上送),所以摘要必须照录 snippet 全文。守卫 `test/claude/websearch-transport.test.ts`。

### Codex 侧无法用 web search

code mode 的 `additional_tools` 里没有 `web_search`;fallback 形态发的 `{"type":"web_search"}` 是 hosted 工具、无 `parameters`,上游给不了。`claude/websearch.ts` 只处理 Messages 中「单个、名为 `web_search`、带日期版 hosted type」的工具。Codex 接受网关产的 `web_search_call` item,所以要支持是可行的,但需新功能(注入工具 + 网关执行 MCP 搜索 + 产 item)。

### GPT credit 锚定与缓存反演

Kiro 不在 usage 里给缓存字段,折扣只落在 credits 上。GPT 计费公式:`credits = 倍率 × [k_in·(未命中 + 0.1·命中) + k_out·输出]`,`k_in = 1.6584e-5`、`k_out/k_in = 6.66`(公开价同比),倍率 = 上游 rateMultiplier。命中 = 同 conversationId 里此前请求的前缀(另有约 7 token 固定尾巴不进缓存);换 conversationId 发同样内容与冷请求逐位相同。

plugin-derived 据此反演(`gptCacheDerivedBreakdown`):按隐藏推理 = 0 解命中数,推理成本被计入未命中,所以推理只会让 `cache_read` 低估。成本锚定 `credits×0.04`(× multiplier),status `gpt_credit_anchored`。**绝不给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`**:Claude 的系数与缓存比例(0.5276)不同,分流必须在价格表查询之前。

- `kiro.inputTokens` 含本次输出(contextUsage 是生成之后的占用,Claude 与 GPT 相同)。GPT 反演先减可见输出;网关对所有模型上报的 `input_tokens` 目前都含输出。
- 误差全在可见输出估算:代入真实输出时公式只差约 −24 token 固定偏移;`estimateOutputTokens` 是字符启发式,误差经 `(k_out/k_in − 1)/0.9 ≈ 6.3` 倍放大——估少则少报命中,估多则冷请求也虚报命中。隐藏推理同理低估约 6.3 × 推理 token。复跑 `test/manual/gpt-cache-derive-live.mjs`。
- 超过 272K 整单 ×2,命中部分也翻倍,分界按含命中的总量算;反演把倍率乘上分档(`GPT_LONG_CONTEXT`),否则越线的一单命中会被截成 0。
- 同会话切换 effort 让 GPT 缓存失效,反演据 credits 报 0 是对的;Codex 同一线程 effort 不变。

## 错误流转 · 容量事件诊断

### 跨模型对照

典型形态:一批下游错误全部来自上游 5xx、网关自身零错误。判别顺序:① 同容器跨模型——同时段某模型大面积失败、另一模型零失败 → 上游按模型容量短缺(上游 429/5xx 日志行不带模型字段,按 `reqId` 关联 info 级入口行的 `model`;`mapped_model` 只在 `debug`);② 分钟级时间轴——失败集中在短窗口、之后流量更高却不失败 → 是事件非长期状态;③ 请求形状(`max_tokens` / `tool_count` / `system_length`)分布相同 → 非 converter 问题;④ region / profileArn / `tier` 全同 → 非路由或配额。别按主机 / 账号先分桶(会误推「账号被封」)。有界重试无效(上游恢复远慢于请求内重试),有效缓解是切模型。日志看 `capacity_reason`,别 substring 匹配 `error`。

### 容量不足的 5xx 为何是 503 而非 502

「压成 502」是给未知失败态的默认值;`MODEL_TEMPORARILY_UNAVAILABLE` / `INSUFFICIENT_MODEL_CAPACITY` 是已知态,同一件事上游还会用 429 和 mid-stream `ThrottlingException` 表达(都是可重试信号),压成 502 会让容量事件看着像网关自己坏了。施加点在 `retry-executor.ts` 的 5xx 分支而非 `classifyErrorBody`:后者跑在 429 分支之前(会劫持更具体的 429)且拿不到 header(丢 Retry-After)。只作用于 5xx,429 / 408 都有反向守卫。下游三元组复用 `upstreamErrorWire(true)`。判别子见 `matchModelCapacityReason()` 与 `MODEL_CAPACITY_REASONS` 头注释;为何恒 503 见 `claude/error-mapper.ts` 的 `overloaded` 分支;为何不自己编 Retry-After 见 `parseRetryAfter` 头注释。

额度判定(见下条)对 402 不看 body,两者代价不对称:漏判额度 = 错且不可重试的 400,容量侧产物是日志维度,似是而非的 token 比没有更糟。别统一这两个函数(反向守卫 `test/kiro/provider-error.test.ts`)。

### 额度耗尽:402 一律算,其它 4xx 看声明的 reason

依据是 KiroRuntimeService 的错误 schema 与 KAS 的映射:

- `ServiceQuotaExceededException` = HTTP 402,reason 为 `MONTHLY_REQUEST_COUNT` / `OVERAGE_REQUEST_LIMIT_EXCEEDED` / `CONVERSATION_LIMIT_EXCEEDED`;该服务的 402 只有这一种。
- `ThrottlingException` = HTTP 429,reason 既有额度类(`MONTHLY_REQUEST_COUNT` / `DAILY_REQUEST_COUNT`),也有真限流(`INSUFFICIENT_MODEL_CAPACITY` / `CREDIT_CONSUMPTION_RATE_EXCEEDED` / `USER_REQUEST_RATE_EXCEEDED` / `SERVICE_REQUEST_RATE_EXCEEDED`)。
- KAS 把 `HOURLY/DAILY/WEEKLY/MONTHLY_REQUEST_COUNT`、`USAGE_LIMIT_REACHED` 转成不可重试的 `UsageLimitReachedError`,`OVERAGE_REQUEST_LIMIT_EXCEEDED` 转成 `OverageLimitReachedError`;只有容量与速率类可重试。

网关规则(`matchQuotaExhausted`,在 `classifyErrorBody` 里、先于 429 分支):402 一律算;其它 4xx 只认声明的 reason 属于 `USAGE_LIMIT_REASONS`,不扫 prose(429 误判会把可重试的限流变成硬停)。下游统一 402 `billing_error`(SDK 不重试),日志 `quota_reason` 记上游 reason。守卫 `test/kiro/provider-error.test.ts`、`test/kiro/retry-executor-429.test.ts`、`test/claude/quota-exhausted-e2e.test.ts`。

流中途的异常帧不看 reason:`ThrottlingException` 帧仍按可重试 503,客户端重发后新请求在建流前拿到 402 / 429。

## 日志四条守卫的理由

部署形态是多容器同机 + 高频健康检查,日志既是排障依据也是磁盘成本。

- **每请求只打一行**:Fastify 内置请求日志与 `onResponse` hook 并存会每请求三行,按 incoming/completed 配对的分析会稳定算错。
- **业务字段一律 snake_case**:混用会逼运维为同一指标查两种拼写。
- **一个指标只有一个 owner**:`capacity_reason` 同一件事有 429 / 5xx 两种线格式;mapper 再记一次会让 5xx 权重翻倍,只记 5xx 又漏掉更常见的 429。
- **网关自己造成的结果不记 `error`**:主动 `destroy()` socket、主动 abort 上游后的读流异常是自身动作的必然结果,记 error 会污染告警、误导成「上游在报错」。

## 上游与客户端的实测事实

### kiro-cli 自己怎么处理 5xx / 429 / 400

500/502/503 → 共 9 次(SDK 内层 3 次带抖动退避 × 应用层外层 3 轮);429 → 3 次,不走内层重试,间隔严格等于 `Retry-After`;400 → 不重试。网关对瞬时故障一次都不重试、原样透传(见 `retry-executor.ts` 头注释 + 「跨模型对照」),瞬时 5xx 上的体感差距全在于此。仅有两个语义重试各一次:401 换 token、400 `THINKING_SIGNATURE_INVALID` 剥掉 `reasoningContent`。探针 `kiro-cli-probe.ts`。

### kiro-cli V3(KAS)的 wire

网关只模拟 kiro-cli `chat --v3` 交互会话一套 wire:对话、工具、subagent 由 KAS(kiro-cli 内嵌的 Node 进程 `@kiro/agent`)发;登录、OIDC 刷新、GetUsageLimits 由 Rust 外壳发。profile 因此分 `kas` / `shell` 两个身份(`kiro/client-profile.ts`)。与 V2 的差异:

| 项 | V2(Rust 引擎,不得回流) | V3(KAS,网关现行) |
|---|---|---|
| target / 路径 | `AmazonCodeWhispererStreamingService.*`,REST 路径 | `KiroRuntimeService.GenerateAssistantResponse` / `.InvokeMCP`,同 host 路径 `/` |
| UA | `aws-sdk-rust/… api/codewhispererstreaming/…` | `aws-sdk-js/1.0.0 ua/2.1 os/<platform>#<release> lang/js md/nodejs#… api/kiroruntime#1.0.0 m/N KiroCLI/<ver> KAS/<ver> os/<platform> md/appVersion-<ver> app/AmazonQ-For-CLI acp-client/kiro-cli` |
| 头 | accept、accept-encoding | 无这两个;GAR 多 `x-amzn-kiro-client-attribution: kiro-cli`;都带 `connection: keep-alive` |
| body | 每条 user 带 `envState`、assistant 带 `messageId` | 顶层 `agentMode`、`sess_` id + `rootConversationId`;无 envState / messageId,空集合不发。`origin: KIRO_CLI` 两者相同 |

- 与 KAS 唯一有意的偏离:system 折进首条 user,不造 `assistant:"I will follow these instructions."`(见「注入文本」);KAS 自己的 `You are Kiro…` 人设不发。同一 prompt 下网关与 KAS 的 GAR body 结构逐键一致。
- axios 会自动补 `accept` / `accept-encoding`,header 值置 `false` 才压得住(`SUPPRESS_AXIOS_DEFAULTS`)。
- 交互与非交互是两种客户端身份:非交互(`--no-interactive`)发 `origin: AI_EDITOR`、归因头 `unrecognized`、UA 末尾 `acp-client/kiro-cli-non-interactive`;交互是 `KIRO_CLI`、`kiro-cli`、`acp-client/kiro-cli`。上游按 origin 注入不同的系统前缀、各自缓存。网关流量是交互式 agent,对齐交互身份。
- 抓包:`scripts/capture-kiro-cli.sh` 在 `script` 伪终端里跑交互式 TUI,stdin 接 keepalive 撑着的管道(TUI 一 EOF 就退出,BSD `script` 不收 FIFO);`--trust-workspace` 只对本次生效。`KIRO_KAS_ENDPOINT` / `KIRO_KAS_CONTROL_PLANE_ENDPOINT` 交互与非交互都认,Rust 外壳靠临时 settings。别用 `KIRO_KAS_SERVER_PATH` 包装器:录出的 UA 是 `KAS/unknown`,不能当画像。
- 守卫 `test/static/kiro-wire-v3.test.ts`、`test/kiro/provider-v3-wire.test.ts`。

### 重试头的三个调用点

`applyRetryHeaders`(`kiro/retry-executor.ts`)是 `amz-sdk-invocation-id` / `amz-sdk-request` / `x-kiro-attempt` wire 格式的唯一 owner(`attempt=N; max=M`、第 2 次起才有的 `ttl=`、`x-kiro-attempt` 的无空格分隔)。三个调用点差异只走参数:executor(`max=3` + Kiro 头)、OIDC refresh(`max=4`)、`getUsageLimits`(`max=1`,不发 Kiro 头)。后两者故意不接 `RetryExecutor`:它抛 `ProviderError`,而 `/kiro/usage` 与 capability 按 `KiroHttpError` 分流(`translateUsageError`),executor 的 body 分类器也是按 messages 端点设计的。抓包侧同名清单 = `scripts/capture-kiro-cli.sh` 的 `RETRY_HEADERS`(剔出 fixture)。别搬回 `provider.ts` 的 `buildHeaders`:那里每次调用生成新 uuid,每次重试都成了「attempt=1 的全新请求」。一次 `execute()` = 一次逻辑调用(共用 invocation-id、attempt 递增);空流重试每次重走 `execute()` = kiro-cli 的外层重试。

### web_search / web_fetch 分别在哪执行

`web_search` → 走上游 `InvokeMCP`(`x-amz-target: KiroRuntimeService.InvokeMCP`、路径 `/`,body 是 JSON-RPC `tools/call` + `{name:'web_search',arguments:{query}}` + `profileArn`,不带 `x-amzn-kiro-profile-arn` 头与 `x-kiro-attempt`),所以网关代为执行(`claude/websearch.ts`);`web_fetch` → 零上游请求,客户端本地抓,网关不实现。网关只旁路「单个、名为 `web_search` 且 type 为 `web_search_YYYYMMDD` 的 hosted 工具」(Claude Code 的独立子请求),同名普通 function 仍交客户端执行。

### 工具调用往返与图片的 wire 形态

KAS 形态:assistant 侧 `{content, toolUses:[{toolUseId,name,input}], reasoningContent?}`(`input` 是对象;只有 toolUses 时 `content:""`)。user 侧 `toolResults:[{toolUseId, content:[{text}|{json}], status:"success"|"error"}]`,不带 `isError`;只含工具结果的 user 消息 `content:""`,无工具结果的历史 user 不带 `userInputMessageContext`。`status` 表示工具本身是否执行成功(`exit 42` 仍是 `success`);`status` 与 `isError` 都不作为失败信号到达模型,判定靠正文,`{json}` 通道我们不产,理由见 `ToolResult` 头注释。tool_result 回传的图片提升到 message-level `images: [{format, source:{bytes}}]`,`toolResults[].content` 原位留占位文本(kiro-cli 是 `"See images data supplied"`,网关是带序号的 `[image k attached to this message]`,见「多图归属只靠顺序」)。

### Responses 的字节量约为 Claude 的 10×

同一段内容 Responses 的字节与事件数都远多于 Claude:上游 GPT 的 delta 分片更碎(事件数约 7.7×)+ Responses 每事件字段更多(`item_id` / `output_index` / `content_index` / `sequence_number`,约 1.3×)。不是丢包也不是编码 bug。运维含义:更吃带宽与写缓冲,背压更早出现。

### 客户端报 InputValidationError 怎么查

先看网关日志有没有 `upstream truncated tool_use (no isComplete frame)`——它只说明上游截断过,未完成的调用已被缓冲、从不上 wire。若仍报 `JSON parse failed`,是新问题(参数在网关侧就该解析失败并报协议错误)。其余两支在客户端侧:`ZOD_VALIDATION`(超 `questions≤4` / `options≤4` / `header≤12`,或违反「问题文本与同题 option label 须唯一」的 refine,后两条 JSON Schema 表达不出、模型看不到)、`PERMISSION_UPDATED_INPUT`。

### 原生 reasoning / effort / system 的 wire 真相

证据来自录真实 kiro-cli 与用网关 provider 直打上游。复跑:`test/manual/reasoning-wire-probe.ts`(直打)、`kiro-cli-capture-proxy.mjs`(录 kiro-cli)、`reasoning-roundtrip-live.mjs`(走网关验收)。

**wire 事实**:

- history 里的 thinking 有原生字段 `assistantResponseMessage.reasoningContent = {reasoningText:{text,signature}}`(GPT 同形,文本为占位;`{redactedContent}` 形态仍接收),不拼 `<thinking>`。signature 缺失或改坏 → 400 `THINKING_SIGNATURE_INVALID`。KAS 的对策:无签名不发、换模型不发、收到该错剥掉全部 `reasoningContent` 重发一次。
- effort 只在顶层 `additionalModelRequestFields` 生效,形状由 `ListAvailableModels` 的 `additionalModelRequestFieldsSchema` 逐模型给出:Claude = `{thinking:{type:adaptive|disabled, display?:summarized|omitted}, output_config:{effort}, max_tokens}`(4.6 系无 xhigh);GPT = `{reasoning:{effort}}`(含 none)。写在 `userInputMessage.reasoning` 的 effort 上游不认。`thinking.type: disabled` 真关;`display: omitted` 只回 signature 帧。
- 回包 reasoning 是摘要:文本长度不随 effort 变,credits 才是 effort 生效的判据;末尾单独一帧只有 `{signature}`。
- 顶层 `systemPrompt` 上游 400(只有 `com.amazon.kiro.runtimeservice` 命名空间有它,KAS 也没发),system 仍折进首条 user。
- 逐模型能力:
  - opus-5 / 4.7 / 4.8:摘要 reasoning + signature,opus-5 默认就思考;
  - sonnet-5:回 signature 帧,计费随 effort 变;sonnet-4.6:加字段后回明文 reasoning + signature,默认不思考;
  - opus-5.5:thinking 只有 adaptive(显式 disabled 回 400 `ValidationException`),effort 默认 medium;sonnet-5.5:adaptive / between_tools(disabled 同样 400),effort 默认 high。KAS 只对 enum 同时含 disabled 与 adaptive 的模型做开关,这两个常开模型只发 effort,也从不发 `between_tools`;
  - haiku-5.5:adaptive / disabled(disabled 真关),effort 默认 medium,简单题 adaptive 会直接不思考;
  - opus-4.6:发字段只涨计费、无帧无签名;
  - 非原生模型只认 `<thinking_mode>enabled</thinking_mode><max_thinking_length>N</max_thinking_length>` 前缀,本项目不注入任何前缀,仅作记录。
- KAS 在客户端没指定时发 schema 的默认 effort(opus-4.7 为 xhigh、opus-5.5 / haiku-5.5 为 medium,其余原生模型为 high;Claude 同时发 `thinking:{type:adaptive}`)。网关照此补默认(`defaultEffort`),只影响不带 thinking / reasoning_effort 的客户端。
- 其它:`ListAvailableModels` 带 `tokenLimits` / `promptCaching` / `refusalFallbackModels`,直打走 KAS 控制面 `management.{region}.kiro.dev`(入口见 `claude-rate-probe.ts` 的 `models` 阶段);`kiro-cli --effort` 与 `/effort` 在非交互和 legacy UI 下不上 wire;Claude Code 的 `thinking.display`、`context_management` 与 beta 头均透传,启动时的 `HEAD /claude/api/hello` 网关 404 不影响。

**本项目的做法**(真相源 `claude/converter.ts`、`claude/types.ts`、`kiro/retry-executor.ts`):

- thinking 只有 adaptive 一种语义:`normalizeThinking` 把 `enabled` 归一成 `adaptive`、丢掉 `budget_tokens`;`resolveEffort` 只看 `output_config.effort`(缺省为模型默认)。
- 原生模型(`MODELS_WITH_NATIVE_REASONING`)由 `buildAdditionalModelRequestFields` 生成顶层字段,`toKiroRequest` 装配、三个 handler 共用;`display` 透传;sonnet-4.6 的 xhigh 降 high;`max_tokens` 不发(会让小 max_tokens 的客户端在思考阶段被截断);客户端没提 thinking 时同 KAS 补默认。
- 常开模型(`MODELS_THINKING_ALWAYS_ON`)收到 `disabled`(`between_tools` 已归一成它)按 adaptive + effort low 发(Anthropic 文档对这类模型「关思考」的替代写法;客户端显式 effort 优先),响应照常带 thinking 块。
- 本轮实际生效的 thinking 只由 `effectiveThinking` 判定,上游字段与响应侧 thinking 通道(`responseThinkingEnabled`)都从它推出;各算各的会让未提 thinking 的流式请求先开一个空 text 块。
- OpenAI 的 `reasoning_effort` / `reasoning.effort`(`reasoningConfigFromEffort`):`none` → disabled、`minimal` → low、缺省或未知取值按模型默认。OpenAI 两个端点不解析 `-thinking` 后缀;Messages 端点的后缀只开 adaptive(`request-validator.ts`)。
- 非原生模型不做任何 thinking 控制:不发字段、不注入前缀;`-thinking` 后缀只打开响应侧 legacy `<thinking>` 解码。
- history:只把带签名的 `thinking` 块放进 `reasoningContent`(`redacted_thinking`:网关信封还原成原生推理,外来的 → `redactedContent`),无签名的丢弃,content 只放可见文本;一条 Kiro 消息一个槽位,多块取最后一块。
- 签名失效:`RetryExecutor` 收到 `THINKING_SIGNATURE_INVALID` 剥掉全部 `reasoningContent` 重发一次(info 级),再失败才 400。

守卫:`test/static/no-thinking-tag-stitching.test.ts`、`test/claude/converter-reasoning-content.test.ts`、`test/claude/native-effort-integrity.test.ts`、`test/kiro/retry-executor-thinking-signature.test.ts`。

### 支持哪些模型 / 加模型要同改的地方

`claude/models-catalog.ts` + `mapModel()`。

- **加 GPT 变体同改**:`mapModel` / `MODELS_WITH_NATIVE_REASONING` / claude catalog(openai catalog 复用它)/ plugin-derived `gptVariant`(跨包复制的变体 token)+ `GPT_RATE_MULTIPLIER`(上游 rateMultiplier);context window 按 `isGptModelId` 前缀判定,Claude 一律 1M,都不用改。
- **加 Claude 模型同改**:`CLAUDE_FAMILIES` / `MODELS_WITH_NATIVE_REASONING` / `MODELS_WITHOUT_XHIGH`(schema 无 xhigh 的才列)/ `DEFAULT_EFFORT_BY_MODEL`(schema 默认不是 high 的才列)/ `MODELS_THINKING_ALWAYS_ON`(schema 的 thinking 没有 disabled 的才列)/ claude catalog / plugin-derived 价格表 + 阈值(漏了不报错、只会 `unknown_model`,守卫 `test/static/derived-price-coverage.test.ts`)。
- `CLAUDE_FAMILIES` 里是往对应家族加一个上游 id(版本号由 id 解析,有无小数点以 list-models 为准)。表里没有的版本(比最新还新、或夹在已知版本之间)一律 400、不降级;只有没有版本号、或不高于 `RETIRED_VERSION_CEILING`(已下线的 4.5 一代)的写法走家族兜底,兜底是家族最新版本(由表推出)。下线一代时显式抬高这个常量。minor 后面紧跟字母的不算 minor(`opus-5-1m` 是 opus-5)。
- 阈值取 Anthropic prompt-caching 文档的最小可缓存长度,随代际不单调(5.5 系与 opus-5 为 512、opus-4.8 / sonnet-5 / sonnet-4.6 为 1024、opus-4.7 为 2048、opus-4.6 为 4096)。
- 两类都要同步 README「支持的模型」表,守卫 `test/static/readme-models-table.test.ts`。Fable 系列 Kiro 尚未提供。

**derived 价格表只管 `claudeEquivalentCostUsd`,反演用的是 Kiro 的计价**。Kiro 按上游 rateMultiplier 计价:opus 系标价正在倍率线上,sonnet-4.6 的 $3 高 1.5%,沿用标价反演;明显偏离的模型进 `KIRO_BILLING`(基价 = opus 标定线 × 倍率 / 2.2,可带未命中溢价与逐模型命中比例);按 prompt 长度分档计价的另进 `LONG_CONTEXT_TIER`。新模型先跑 `test/manual/claude-rate-probe.ts`(计费)与已标定模型同尺寸对照。标定结论:

- **opus-5.5**(2.0x):输出与命中按倍率缩放,未命中输入是基价的 1.942 倍,命中价 = 基价 × 0.53。冷启动比 opus-5 贵约 77%,稳态命中便宜约 9%。溢价只落在 prompt 上:全未命中基线 = 溢价 ×(T − 可见输出)+ 可见输出;乘到整个 T 上会凭空多出命中。
- **sonnet-5**(1.3x):Kiro 计价与 sonnet-4.6 逐项相同、无溢价;标价 $2 离开倍率线,按标价反演会把高命中算成一半,故进 `KIRO_BILLING`。≥30K token 的随机串文档会触发 `CONTENT_FILTERED`(空流、不计费),标定时调小 `K2C_WORDS_*`。
- **sonnet-5.5**(1.3x):命中与输出同 sonnet-5,未命中输入是基价的 1.942 倍。「命中前缀 + 新内容」这一形状两个 sonnet 上游都没完整命中,是上游缓存行为、不是反演误差。
- **haiku-5.5**(标 0.06x 但不在倍率线上):未命中、命中、输出都是 Anthropic 标价 × 0.4617(11.54 credit/$),命中 / 未命中 = 0.1,输出 / 输入 = 5;prompt 超过 100K 整单 ×5(命中部分同样,分界按含命中的总量算)。故进 `KIRO_BILLING`(`kiroBillingFromList`)+ `LONG_CONTEXT_TIER`。
- opus-5 老标定仍成立;sonnet-4.6 按 $3 反演会让冷请求多出约 3.7% 命中(既有残差)。
- 已知残差:小 prompt + 长输出时 Claude 路径低估命中,根因同 GPT(core 按 4 字符 / token 估可见输出,误差经 `k_out` 放大);Claude Code 稳态流量输出占比小,影响有限。
