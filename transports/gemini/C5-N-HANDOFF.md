# C5-N Cloudflare Named Tunnel 正式连接器交接

## 定位与事实基线

此实现只属于 Gemini feature/gemini-web 独立工作区，不修改公共 Core、GUI、稳定 main、正式 ChatGPT LDC 或研究隧道。继承 C5-U TunnelManager、Runner、OAuth Gateway、DPAPI、CLI/Console，新增 cloudflare-named-agent.mjs。研究验证的 Cloudflare Remotely Managed Named Tunnel 在当前规则+TUN 环境 30 分钟单连接器健康检查 360/360 PASS、SSE 最长 600 秒 PASS，依据 CF-R5.3-FINAL-2026-11-28.md，不将研究 fixture 冒充正式 Gemini OAuth/MCP。

## 固定公网配置

每个 Gemini 实例独立拥有 Cloudflare Tunnel、凭据与主机名。正式示例：

- Provider：cloudflare-named；issuer=https://gemini.venpenmen.dpdns.org
- Tunnel 名称建议：ldc-gemini（与 ldc-research 分开）
- Published Route Hostname：gemini.venpenmen.dpdns.org
- Service Type：HTTP；Service URL：http://127.0.0.1:18767
- 本地 OAuth Gateway：固定回环端口 localPort=18767（可在 provider 配置中修改，改动后需同步 Cloudflare Route）
- 配置文件（非秘密）tunnel-config.json：schema=1、provider、issuer、localPort 和可选 tunnelId。
- Token 通过 console [14] 隐藏输入，或仅本地受保护 CLI tunnel.credential.set 写入实例的 credentials/tunnel-cloudflare-named.dpapi；绝不发送到对话、Git 或普通日志。

Cloudflare Dashboard 由用户手动创建 Tunnel 和 Published Route；LDC 不需要 Cloudflare 管理 API，不安装 Windows Service，不改系统代理、TUN、防火墙或全局 cloudflared 安装。确认 Domain、Route 与 localPort 一致后再开启实际公网。

## 启动、鉴权与验证

1. console [13] 选择 Named，输入固定 Issuer、Tunnel ID（可留空）和 localPort（默认18767）；变更旧 Issuer 必须按提示 RESET 并重做 OAuth。
2. console [14] 本地隐藏导入用户独立的 Tunnel Token；仅在停止状态允许改动。
3. console [3] 启动原生 Bridge、固定回环 OAuth Gateway，再创建唯一受管 cloudflared 子进程。Agent 从实例 DPAPI 载入 Token，先创建空文件、设置 Windows 当前用户与 SYSTEM 的独占 ACL，再写入 Token，通过 --token-file 参数运行受签名/哈希核验的 cloudflared 2026.11.2。
4. publicTunnel.verified 只有在固定域名真实返回 OAuth 授权服务器元数据、受保护资源元数据及未授权 /mcp HTTP 401 Bearer 挑战时才是 true；本地 ready 不等于公网 verified，也不等于 Gemini 官方网页 L5。
5. console [11] 检查真实公网，按 Gemini 页面提示的精确 Google OAuth 回调通过 [4] 注册、[5] 一次性预批准、[6] 仅本地展示客户端凭据。
6. 结束时选 [9] 停止受管实例，[Q] 退出；本地临时 Token 文件应清理，DPAPI 静态密文保留，固定 Issuer 与已有授权可在不更改配置时延续。

连接器每次只能有一个所有者。同一运行根内按固定 Issuer 维护共享进程锁，并使用私有进程记录。异常退出在有限次数延时后重连，避免同 Tunnel 多连接器同时注册；无法证明归属的存活孤儿进程一律拒绝自动接管/误杀，需安全人工恢复。Token/进程归属检查失败时 fail closed。公网探测不能自动重放具有写入副作用的 MCP 请求。

## 本地实现与待完成项

- C5-N 代码：cloudflare-named-agent.mjs、tunnel-contract.mjs、tunnel-manager.mjs、runner.mjs、console.mjs；CLI 复用 C5-U 原命令。
- 新增定向测试：cloudflare-named-agent.test.mjs。另有既存 c5-unified-* 测试适配 Reserved → Local。
- 可复用本地签名二进制位于本分支被 Git 忽略的 test-runtime/gemini-personal/bin/cloudflared.exe；SHA256 555B46C85582461D189CAC30D14AD05480D612613801BE9F110B8CE08C5B2113。不得将 exe 或敏感凭据提交。
- 尚无正式独立 ldc-gemini Tunnel、Token/Route 的部署证据；真实公网站点 OAuth/MCP L3、Gemini 网页 L5、Windows 整机重启与跨 SakuraCat 节点切换不得因本地测试通过而声明 PASS。
- 用户创建正式 Tunnel 前，不得复用研究凭据或直接更换 research 入口。涉及全局网络与重启的测试留维护窗口。

详细验收见 C5-N-ACCEPTANCE.md、C5-N8-ACCEPTANCE.md 与 C5-L5-ACCEPTANCE.md；工程发展路径 C5-N → C5-L5 → C6 公共管理 → C7 GUI。

2026-11-28 C5-L5 追加：Gemini 官方网页已真实关联并验证 Restricted/Files 14 项工具及文件读写/越界拒绝，Restricted/Terminal 21 项工具发现及 PowerShell `start_process` 实际执行；服务端审计交叉核对成功。权限变化会撤销旧 OAuth Grants；旧对话工具集0，新对话重新关联后恢复21项，具体原因尚不明确。正式实例 Full/Files 及 Full/Terminal 切换后已核对工具数与公网状态，四模式真实 MCP 调用由独立本地6/6回归验证，官网 Full 两模式未实际调用。当前已恢复 Restricted/Files 14项、公网 verified；原 OAuth 客户端保留而 Access/Refresh Grants 为0，Gemini 官网后续需重新关联授权。完整54/54 PASS。曾在对话显示 Client Secret，必须在后续官网用户操作窗口完成安全轮换；不要认为本轮已完成轮换。

2026-11-28 C5-N8 增量：用户已创建独立 Named Tunnel / Published Route，DPAPI Token 加密导入；经真实公网 OAuth PKCE、MCP initialize、14 工具发现、隔离 read_file、撤销 401、受管重启、单独自有连接器故障恢复与 refresh grant 重启后继续有效。Windows 信号退出误判和 loopback X-Forwarded-For 告警已修复。当前有一个独立本地控制台会话管理实例，关闭控制台会停止服务，且不具备开机自动启动；用户在 Gemini 官网配好真实回调并完成浏览器 L5 之前不可宣称官网已验收。
