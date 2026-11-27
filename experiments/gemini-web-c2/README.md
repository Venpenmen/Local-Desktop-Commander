# Gemini 网页最小探针

先在本目录执行 npm ci 和 npm test。Windows 运行入口是 Run.ps1，支持 Start、Status、Stop。Start 默认仅在回环监听。使用 -Public 时，先将经 Cloudflare 官方发行 SHA-256 校验的 cloudflared.exe 放入忽略的 runtime 子目录。使用 Start -Public -Seconds 3600 启动一小时临时实验，保存返回的 ID。用 Status -Id 查询实际地址，用 Stop -Id 停止对应实例。

探针只实现一个无副作用工具。它使用 MCP SDK 的无会话 Streamable HTTP 和 JSON 响应。无认证入口只允许 POST /mcp，没有 LDC 文件、终端或进程集成。Quick Tunnel 的地址随重启变化，且不支持 SSE。日志中 self-test 标识显式自测，其他公网请求需要与独立网页对话的随机结果交叉核对。

参考 [Gemini 自定义应用](https://support.google.com/gemini/answer/17209137)、[Google OAuth 指南](https://developers.google.com/connected-apps/mcp/oauth) 和 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
