# Gemini 网页最小探针

先在本目录执行 npm ci 和 npm test。Windows 运行入口是 Run.ps1，支持 Start、Status、Stop。Start 默认仅在回环监听。使用 -Public 时，先将经 Cloudflare 官方发行 SHA-256 校验的 cloudflared.exe 放入忽略的 runtime 子目录。使用 Start -Public -Seconds 3600 启动一小时临时实验，保存返回的 ID。用 Status -Id 查询实际地址，用 Stop -Id 停止对应实例。

探针只实现一个无副作用工具。它使用 MCP SDK 的无会话 Streamable HTTP 和 JSON 响应。无认证入口只允许 POST /mcp，没有 LDC 文件、终端或进程集成。Quick Tunnel 的地址随重启变化，且不支持 SSE。日志中 self-test 标识显式自测，其他公网请求需要与独立网页对话的随机结果交叉核对。

参考 [Gemini 自定义应用](https://support.google.com/gemini/answer/17209137)、[Google OAuth 指南](https://developers.google.com/connected-apps/mcp/oauth) 和 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

## OAuth 探针实验

使用 Start -OAuth -Seconds 7200 创建隔离的临时 HTTPS 实验。用 AddClient 登记 Gemini 界面显示的精确回调。操作者在本机运行 Run.ps1 Arm -Id <实验ID>，允许接下来五分钟内仅一次匹配手动客户端和精确回调的探针授权。授权请求通过客户端、精确回调和 S256 参数校验后，原子消费本机许可，并签发绑定该 OAuth 事务的一次性授权码。SDK 验证 S256 PKCE。访问令牌最长十分钟；刷新授权最长三十分钟，仅绑定当前手动客户端及探针权限，撤销时整组失效。临时域名随实例变化。

运行 node --test oauth.test.mjs 验证本地安全边界。公网测试设置 LDC_C2_OAUTH_URL 和 LDC_C2_RUN 后执行同一脚本。HTTPS 诊断需要现有代理时，仅在测试进程设置 LDC_C2_TEST_PROXY。OAuth 探针阶段仅允许无副作用的随机回执工具。

若平台要求手动注册，在运行中的 OAuth 实验使用 Run.ps1 AddClient -Id <实验ID> -RedirectUri <Gemini 显示的精确地址>。凭据生成在本机受保护的 manual-client.json。切换实验地址后需重新核对 Gemini 显示的回调。诊断日志记录 OAuth 路由、HTTP 状态及注册认证方式，不保存原始查询、请求体或密钥。

使用 node --test consent-browser.test.mjs 在 Edge 无头浏览器验证预批准前拒绝、批准后直接跳转和重复授权拒绝。诊断记录原因分类，不保存表单字段值、来源地址或批准码。
