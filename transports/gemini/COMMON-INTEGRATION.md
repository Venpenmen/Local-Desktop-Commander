# Gemini C4 → C5/C6 共享集成提案

## 当前可交付的边界

Gemini 分支的 `transports/gemini` 实现原生 MCP stdio 桥接、14/21 项工具的完整 Schema 转发、Restricted/Full 文件模式和单独的本地实例。C4 回归使用 127.0.0.1、短期随机 Bearer 及测试夹具，不修改公共管理层、ChatGPT 隧道或 GUI 分支。

`cli.mjs` 是同一 Node 进程中的独立控制 CLI，不是公共 `management/LDC-CLI.ps1` 的单请求无状态实现。它只负责 C4 验证，不能冒充当前 M7 管理协议 v1 的正式 Gemini 注册结果。

## C5：Gemini 官方公网连接

1. 在独立正式适配器中集成已验证的 C2 OAuth/PKCE 和 Gemini 官方回调逻辑，删去重复实验 OAuth 实现；客户端注册、短期令牌和刷新授权按实例隔离。
2. 公网 Streamable HTTP 必须先完成 HTTPS、OAuth 和用户明确授权，禁止把 C4 本地 Bearer 或无认证 HTTP 直接暴露到公网。
3. 研究稳定且零新增费用的域名/隧道方案，保留 Quick Tunnel 的临时实验模式。公网地址与令牌状态分别报告。
4. 每次扩大工具白名单、启用终端或改为 Full 时，使已有 OAuth 授权失效，重新完成本机确认和 Gemini 账户授权；不能静默升级既有只读令牌。
5. 验证断线重连、刷新、过期、进程退出及机器重启；L5 必须由 Gemini 官方网页真实调用证明。

## C6：从公共 develop 分支集成管理模块

必须从 `develop` 派生独立公共维护分支，先更新公共 API 契约和测试，再合入 `develop` 并分别同步 GUI/Gemini：

- 以可信内建适配器方式新增 `gemini`，而不是让任意 manifest 自动执行脚本；审查 `management/LDC-Core.ps1` 的适配器注册和 `management/LDC-Instance.ps1` 的实例标识。
- 统一实际/目标状态、修订号、权限切换提示、启动/停止/重启、任务进度与错误代码；保证 JSON CLI 仍是单请求 PowerShell 5.1 子进程。
- Gemini 进程观测必须核对执行文件、命令行、PID、出生时间、实例运行目录和监听地址；无法确证身份时停止操作须拒绝。
- 引入 Gemini 独立的 credential/DPAPI 存储、审计日志与诊断字段。真实网络连接及本地 MCP 就绪分别展示。
- 建立公共契约测试、双实例互不影响测试，并保留 OpenAI 已发布服务的冻结边界。
- 扩展 manifest 可声明适配器元数据，但不因解析 manifest 自动获得执行权限。

## C7：GUI 消费接口

GUI 只调用公共管理协议，不直接触碰本分支私有配置。展示 `fileAccess.actual` / `target`、Restricted 授权根、Full 与终端风险提醒、重启生效标志、OAuth 授权及公网健康。GUI 关闭不应自动停止引擎。

**当前状态：** C4 本地工具/权限能力完成后，由主计划端审核上述 C5/C6 提案。C4 的本地测试不能替代未来的 Gemini 网页接入和公共管理集成。
