# C5-U → C5 Named / C6 / C7 交接

## 基线与工作区

仓库 Venpenmen/Local-Desktop-Commander，Gemini 工作区 D:\Desktop\Local DC\LocalDC-M7-Gemini，分支 feature/gemini-web。公共 Core/develop、GUI/feature/management-gui 仍在 M7-ACCESS 公共基线 e2addd0；稳定 main/v1.0.0 不变。

C2 已有实际 Gemini 官方网页 OAuth/read_file 限定目录验收；C3 独立适配、C4 原生 14/21 工具及 Restricted/Full、本地 C5 OAuth/DPAPI/令牌保护已完成。C5 完整公网 Gemini 网页 L5 仍未完成。C5-U 只做 Gemini 分支内接口抽象，不能视为 C6 公共管理 API 或 C7 GUI 已集成。详见 C5-U-ARCHITECTURE.md。

## Cloudflare Named 专项会话需交付

1. 明确拟使用的 HTTPS 固定主机名，是否已有 Cloudflare DNS zone。
2. 提出 Remotely-managed Token 或 Locally-managed JSON 的方案，并给出启动参数；真实密钥只在本地输入。
3. 核实账户、域名、TLS、DNS、QUIC/HTTP2、出站7844及 SakuraCat 代理/TUN 兼容性。
4. 验证 Google OAuth 回调、MCP 元数据、Streamable HTTP、缓存/安全挑战行为。
5. 核实电脑重启、客户端退出、断网同域名恢复；记录真实测试证据。
6. 核实实际购置/续费金额，涉及支付须用户确认。

Named 目前仅预留 Provider 能力、固定域名配置、独立 DPAPI 凭据文件。启动明确返回 TUNNEL_PROVIDER_NOT_INSTALLED，不把占位接口标记为可用。等专项研究返回结果，再增加完整受管 Agent 和官方网页 L5。

## C6 公共管理 API 消费契约

新增命令（独立 CLI 协议版本仍为 v1）：

- tunnel.capabilities：返回 provider 能力与 implementation（local/reserved）。
- tunnel.provider.get：返回配置、revision。
- tunnel.provider.set：输入 revision、confirmed、config，变更发行地址需 resetAuth 和 riskAcknowledged。
- tunnel.credential.set/clear：仅本地安全控制面输入，绝不回传 Token。
- tunnel.check：真实 HTTPS OAuth 资源元数据探测。
- start/stop/restart/state：继承现有 API，分别体现 Engine/OAuth/Tunnel 的状态。

状态保持 C5 旧字段 connection.publicTunnel、connection.targetIssuer、ngrokTokenConfigured；新增 tunnelProvider、tunnelCapabilities、tunnelConfigRevision、tunnelCredentialsConfigured。

公共管理及扩展注册须由 develop 派生独立公共维护分支实施；不能直接在 Gemini 工作区修改公共 management 目录。文件 Restricted 根限制不限制终端工具的 Windows 用户权限；Full/terminal 继续单独确认。

## C7 GUI 消费契约

在 GUI 设置页面展示目标/实际提供商、固定/动态地址、当前 OAuth 授权、真实公网探测、进程归属、授权是否失效及风险提示。Quick 随机地址重新分配时提示重新关联 Gemini 并允许复制新 MCP URL。Named 未安装时显示未实现，不显示虚假的连接成功。凭据输入需受保护，任何 Token、Client Secret、Bearer 不在普通界面或日志展示。关闭 GUI 不等于停止引擎。

## 安全与联调边界

- Quick 动态入口在发行地址确定及 OAuth 网关初始化以前只返回 503；Agent 退出立即禁用转发，只有显式重启才能得到新随机域名并重新授权。
- ngrok 旧配置及 DPAPI 凭据原样保留；外部 HTTPS 模式不拥有、也不能停止外部隧道进程。
- ngrok/Quick 完整 Gemini C5 L5 仍需要真正远端试验；Mock/本地测试不能替代。
- 本轮不碰正式 ChatGPT 服务、公共 Core/GUI、系统全局代理和付费账户。
