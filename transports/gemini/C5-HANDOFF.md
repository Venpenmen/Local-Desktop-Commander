# M7-C5 Gemini 正式 OAuth / 稳定公网连接交接

当前工作区只修改 `feature/gemini-web` 的 `transports/gemini`。稳定 main/v1.0.0、公共 develop 和 GUI 工作区不动。C2 官方 Gemini 网页 read_file 真实验收已存在，C4 14/21 原生工具及四权限模式本地通过。本阶段把 C2 OAuth 能力与 C4 正式网关结合，仍须用真实 Gemini 官方网页验证。

## 本地已完成及证据

- `oauth.mjs`：从 C2 PKCE/手动注册流程演进；严格 Google 回调、一次性本机授权、授权码防重放、访问/刷新令牌绑定发行地址与配置修订号、支持撤销。
- `secret-store.mjs`：Windows 当前用户 DPAPI 加密保存 OAuth 注册、访问/刷新授权和单独 ngrok authtoken；不会以明文保存或回退。
- `oauth-gateway.mjs`：公网 OAuth 入口与内部 C4 本地 Bearer 网关隔离，Streamable HTTP 原样代理、完整原生工具 Schema 和结果。公网入口仅监听 Windows 回环，必须由专属 HTTPS 隧道转发。
- `runner.mjs`：分别报告本地 MCP、OAuth 和隧道就绪；绑定独立实例，配置改变让旧 OAuth 授权失效，正常重启复用 DPAPI 中的客户端信息及刷新授权。
- `ngrok-agent.mjs`：仅允许免费静态开发域名 `*.ngrok-free.dev/app`，验证官方 ngrok Windows 数字签名，以最小化流量检查/管理的私有配置运行并限定自有进程停止；网络失败采用有限退避和公网 OAuth 元数据实际探测。
- `console.mjs`、`Start-Gemini.cmd`：独立本地 Windows 交互入口，可配置免费域名、隐藏输入 ngrok 令牌、OAuth 关联及权限切换、状态、停止/重启、吊销。
- `c5-cli.test.mjs`、`oauth.test.mjs`、`c5-permissions.test.mjs`、`c5-security.test.mjs`、`c5-tunnel.test.mjs`、`ngrok-agent.test.mjs`：本地真实引擎和 OAuth 测试，公网重连部分通过 mock ngrok agent；**不可等同于真实 ngrok/Gemini 端的 C5 L5**。

## 已核实的第三方运行依赖

零新增费用候选：ngrok 官方 Free 提供账号分配的固定 `*.ngrok-free.dev` 开发域名，有 HTTP 请求和出口数据额度。账户、免费限制和 Gemini OAuth 的跨域/浏览器插页兼容性仍需真实验收。

Windows 官方客户端 ngrok v3.39.13 已从 ngrok 官方发布源下载并在 Gemini 独立运行区内验证 Authenticode Valid，路径：

`<Gemini-Worktree>\test-runtime\gemini-personal\bin\ngrok.exe`

这个可执行文件、测试凭据和运行日志不在 Git 中，也不修改 Windows 全局网络/代理。ngrok 客户端仅独立实例使用，不会使用或停止正式 ChatGPT LDC 隧道。

## 用户人工步骤（仅在完成本地 C5 预验收后执行）

1. 在 `https://dashboard.ngrok.com/signup` 免费注册或登录。确认使用 Free，不升级付费计划。进入 ngrok Dashboard 的 Domains/Assigned Dev Domain，复制免费分配的固定 HTTPS 域名（这个域名可以直接发回 ChatGPT）。
2. 在控制台内 **自己输入 ngrok authtoken**，不要在 ChatGPT、邮件或截图中暴露。Windows 本地入口为 `transports\gemini\Start-Gemini.cmd`，选择 [1] 设置免费 HTTPS 域名，[2] 隐藏输入 authtoken，输入的令牌只保存到当前 Windows 用户 DPAPI 文件。
3. 等公网地址元数据真实通过，再由 Gemini 官方网页版新增自定义 MCP 应用，粘贴 `https://<分配域名>/mcp`。Gemini 生成的**精确 Google OAuth 回调地址可以发回 ChatGPT**，由本地入口注册（[4]）、读取 OAuth client ID/secret（[6]，只在电脑上填写 Gemini 设置，绝不要贴进聊天）。
4. 在本地选 [5] 单次预授权之后完成网页关联。由用户发出由本地随机文件生成的只读、越界及之后完整 14/21 工具测试提示；按需要切换 Full/terminal 时必须本地确认、OAuth 重新授权。
5. 完成断线、临时隧道退出、重启和重新加载授权回归；最终再审阅公网日志、安全、撤销及 Git 交付。

## 必须严格保留的 C5 与后续界限

C5 之前：实际独立原生 MCP + OAuth 本地真实测试；公网 ngrok 尚未验收、正式完整 Gemini 网页工具调用尚未验收。未经真实用户 OAuth 网页回执，不得标记 C5.1 静态公网兼容和 C5.8 L5 PASS。

Restricted 控制的是**文件工具的授权根**；21项完整工具中的终端执行仍有当前 Windows 用户权限。Full 模式和任何 terminal 模式需用户明确本机确认，增权前作废旧 OAuth grant。

C6 由公共维护分支实现正式管理 API/扩展注册，C7 再由 GUI 消费公共 API；C5 独立入口不等于公共管理系统集成。
