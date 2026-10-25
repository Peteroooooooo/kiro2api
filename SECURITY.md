# 安全策略

## 报告漏洞

请**不要**为安全问题开公开 issue,改用本仓库的私有 GitHub Security Advisory。

我们力争在 72 小时内确认收到,并在 7 天内对高危问题给出修复方案。

## 范围

- `packages/core/` 中的鉴权绕过 / API key 或上游凭据泄漏
- 构造的请求或上游 payload 导致内存 / CPU 耗尽
- 响应 body 泄漏上游错误细节,或 `/api/*` 镜像漏剥插件字段
- `@kiro2claude/plugin-api` 契约本身的缺陷(插件与 core 同进程运行,第三方插件按受信代码对待)

## 支持的版本

只修最新的 `master` 与对应的 `ghcr.io/yupanzi/kiro2claude:latest` 镜像,不向旧 tag 回移。
