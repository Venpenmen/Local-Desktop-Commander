# Local DC · Gemini C4 独立适配器

本模块用于 **Windows 本地开发验收**。已支持原生 MCP 14个文件工具 / 21个完整工具、Restricted/Full 两种文件访问权限，仍未接入正式 Gemini 网页和公共管理面板。

## 开发验证

在 Gemini Git Worktree 执行：

```powershell
cd '<Gemini-Worktree>\transports\gemini'
npm.cmd ci --offline --ignore-scripts --no-audit --no-fund
npm.cmd test
```

测试运行目录在 Git 忽略的 `test-runtime`，所有测试文件、终端会话和令牌均为独立实例。日志位于每个实例的 `logs/events.ndjson`，只记录允许的事件字段。

## 独立本地控制入口

```powershell
node cli.mjs '..\..\test-runtime\gemini-local' gemini-local
```

该进程接收 JSON 行请求，保持实例和服务生命周期，退出时关闭所属原生引擎：

```json
{"protocol":1,"id":"status-1","operation":"state"}
{"protocol":1,"id":"config-1","operation":"config.get"}
{"protocol":1,"id":"start-1","operation":"start","arguments":{"confirmed":true}}
{"protocol":1,"id":"stop-1","operation":"stop","arguments":{"confirmed":true}}
```

`config.set` 需要当前 `revision`、`confirmed:true` 和目标配置。可选 `accessMode:restricted/full`、`toolMode:files/terminal`、`tools:all` 或显式工具白名单、`root` 指定已有合法本机目录。Full 或 terminal 增权要求 `riskAcknowledged:true`；增权后的启动也要求再次确认。配置在停止时保存，下次启动生效。

**安全提醒：** 终端工具始终使用当前 Windows 登录用户权限。即便文件访问为 Restricted，终端命令也可以操作其 Windows 账户本来有权限访问的根外文件。只有文件工具使用根目录保护。

当前 C4 回环网关使用进程内短期随机令牌，独立 CLI 仅报告授权状态、不导出令牌。此设计用于自动化本地测试，**不是可直接向 Gemini 网页发布的入口**。C5 将集成真实 OAuth 和正式 HTTPS，C6 才接入公共管理协议。

`write_pdf` 原生 PDF 页面编辑可用，Markdown→PDF 创建被固定上游 Local DC profile 禁止。C4 保持该限制。

验收详见 `C4-ACCEPTANCE.md`；C3 历史清单详见 `C3-AUDIT.md`；跨分支依赖见 `COMMON-INTEGRATION.md`。
