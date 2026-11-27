# Gemini 网页最小探针

先在本目录执行 npm ci 和 npm test。Windows 运行入口是 Run.ps1，支持 Start、Status、Stop。Start 默认仅在回环监听。使用 -Public 时，先将经 Cloudflare 官方发行 SHA-256 校验的 cloudflared.exe 放入忽略的 runtime 子目录。使用 Start -Public -Seconds 3600 启动一小时临时实验，保存返回的 ID。用 Status -Id 查询实际地址，用 Stop -Id 停止对应实例。

探针只实现一个无副作用工具。它使用 MCP SDK 的无会话 Streamable HTTP 和 JSON 响应。无认证入口只允许 POST /mcp，没有 LDC 文件、终端或进程集成。Quick Tunnel 的地址随重启变化，且不支持 SSE。日志中 self-test 标识显式自测，其他公网请求需要与独立网页对话的随机结果交叉核对。

参考 [Gemini 自定义应用](https://support.google.com/gemini/answer/17209137)、[Google OAuth 指南](https://developers.google.com/connected-apps/mcp/oauth) 和 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

## OAuth 探针实验

使用 Start -OAuth -Seconds 7200 创建隔离的临时 HTTPS 实验。用 AddClient 登记 Gemini 界面显示的精确回调。操作者在本机运行 Run.ps1 Arm -Id <实验ID>，允许接下来五分钟内仅一次匹配手动客户端和精确回调的探针授权。授权请求通过客户端、精确回调和 S256 参数校验后，原子消费本机许可，并签发绑定该 OAuth 事务的一次性授权码。SDK 验证 S256 PKCE。访问令牌最长十分钟；刷新授权最长三十分钟，仅绑定当前手动客户端及探针权限，撤销时整组失效。临时域名随实例变化。

运行 node --test oauth.test.mjs 验证本地安全边界。公网测试设置 LDC_C2_OAUTH_URL 和 LDC_C2_RUN 后执行同一脚本。HTTPS 诊断需要现有代理时，仅在测试进程设置 LDC_C2_TEST_PROXY。OAuth 探针阶段仅允许无副作用的随机回执工具。

若平台要求手动注册，在运行中的 OAuth 实验使用 Run.ps1 AddClient -Id <实验ID> -RedirectUri <Gemini 显示的精确地址>。凭据生成在本机受保护的 manual-client.json。切换实验地址后需重新核对 Gemini 显示的回调。诊断日志记录 OAuth 路由、HTTP 状态及注册认证方式，不保存原始查询、请求体或密钥。

使用 node --test consent-browser.test.mjs 在 Edge 无头浏览器验证预批准前拒绝、批准后直接跳转和重复授权拒绝。诊断记录原因分类，不保存表单字段值、来源地址或批准码。


## C2.5: isolated real LDC read_file experiment

This stage is **separate from** the C2.4 ldc_probe and does not change its OAuth source, run, token, or client registration. Start the isolated file reader using `Run-Read.ps1 Start -OAuth -Seconds 7200`; local-only testing uses `Run-Read.ps1 Start -Seconds 120`. The standalone runner creates a private copy of the pinned LDC stdio launcher, uses the existing upstream engine implementation through a local junction, and sets `access-mode.txt=restricted` with `allowed-root.txt` pointing to a newly created run-specific `gemini-read-instance/workspace` directory. Terminal mode is never enabled. It is an experimental transport, not the general-purpose C4 adapter.

Only `read_file(path, offset?, length?)` is discoverable. The bridge forwards this invocation to the actual pinned LDC engine, explicitly disables URL fetching and rejects other tools at the gateway. The original engine enforces canonical root, local drive and junction path rules. The public gateway requires an OAuth token with the **file:read** scope, using isolated client registration and the original local single-use preapproval security pattern. Anonymous public mode is intentionally unsupported. Local-only mode binds to 127.0.0.1 for integration tests.

Manual installation on Gemini: obtain the exact Google callback for the **new file-read app**, run `Run-Read.ps1 AddClient -Id <ID> -RedirectUri <callback>`, enter the locally generated credentials in Gemini **without copying secrets to chat**, and run `Run-Read.ps1 Arm -Id <ID>` immediately before authorization (valid for five minutes). The Quick Tunnel address and OAuth client are run-specific and expire; never use the C2.4 probe client to grant file access. `Run-Read.ps1 Status -Id <ID>` checks the owned process; `Stop -Id <ID>` stops its process tree, revokes in-memory tokens and records shutdown.

Regression: `node --test read.test.mjs read-oauth.test.mjs read-runner.test.mjs`. Evidence is under the ignored `runtime/<ID>` tree. Stop the public experiment after Gemini website proof. Do not publish any `runtime/` evidence, client secrets or actual file contents. The Windows engine has normal user OS permissions; the restricted root and tool whitelist provide application-level constraints, not an operating-system sandbox.

C2.5 official Gemini web acceptance (2026-11-27): authenticated native read returned the exact random fixture; out-of-root access returned the native authorization error. Both public calls correlated with local path hashes and user screenshot. The dedicated gateway, stdio engine and tunnel were stopped. C3 formal adapter design is next.
