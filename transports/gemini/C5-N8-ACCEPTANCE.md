# C5-N8 正式 Cloudflare Named Tunnel 公网验收

## 执行范围和约束（2026-11-28）

工作区 feature/gemini-web，基线 12afc1e770988860419756ea7d6a3faf8f107cab。用户已在 Cloudflare 账号创建独立的 remotely managed Tunnel `ldc-gemini`，Published Route `gemini.venpenmen.dpdns.org` → `http://127.0.0.1:18767`，并通过本地进程安全提取 Token 导入实例独立 DPAPI。Tunnel Token、OAuth client secret、Bearer/refresh Token 均不提交仓库和普通日志。没有安装 Windows Service、改动系统代理/TUN 或使用研究 Token。

启动实例：`test-runtime/gemini-personal/ldc-gemini`。代码仍由本分支原有 `console.mjs`/Runner/TunnelManager 管理受管 cloudflared；测试默认 Restricted/14 文件工具。退出本地控制台将停止所拥有的服务，Windows 整机重启后仍需按既有控制台流程重新启动，本阶段不实现 Windows 开机自启动。

## 真实公网验证记录

| 项目 | 状态 | 实际证据 |
|---|---|---|
| P0 基线和隔离 | VERIFIED | 固定 Issuer、Tunnel ID、18767、DPAPI 实际存在；私有二进制 SHA256 555B46C85582461D189CAC30D14AD05480D612613801BE9F110B8CE08C5B2113、Authenticode Valid；研究隧道 PID 1224 未修改 |
| P1 连接器启动 | VERIFIED | 实际 cloudflared 子进程与原生 Bridge、OAuth Gateway 启动；本地 18767，14 项 Restricted 工具；受管状态 ready、verified true |
| P2 公网 HTTPS | VERIFIED | DNS/HTTPS 真实链路下 OAuth 授权服务器和受保护资源元数据 200；与固定 issuer/resource 完全匹配 |
| P3 未授权安全 | VERIFIED | 公网 POST /mcp 返回 401 Bearer；不提供任何原生 MCP Bearer 直达入口 |
| P4 OAuth → MCP | VERIFIED（独立公网客户端） | 真实公网 OAuth 303、PKCE、Token 200；MCP initialize、tools/list（14 项）、tools/call/read_file 读取隔离 fixture 成功并回传，Restricted 下非文件终端工具拒绝；撤销后 401 |
| P5 权限与撤销 | VERIFIED（Restricted/14 公网；其余依历史本地） | Restricted 公网拒绝 start_process；access revoke 后失效；Full/terminal 四组合沿用 C5 历史本地回归，本轮不主动提权、不会未经二次确认开启公网终端 |
| P6 生命周期 | VERIFIED（范围内） | Windows SIGTERM 退出判断误判经修复；同一受管实例真实 stop/restart，Issuer 和 localPort 不变，重新验证公网；对进程 PID、创建时间和私有签名 cloudflared 路径核验后，故障注入只结束 Gemini 自有 child，有限退避自动恢复。未触碰研究连接器 |
| P7 OAuth 持久化 | VERIFIED（独立公网客户端） | DPAPI Refresh Grant 重启前创建；真实 Agent 重启后公网刷新获得新 Access Token、tools/list 返回 14 项、撤销后 401 |
| P8 定向稳定性 | VERIFIED | 实际公网 40/40：16 次顺序元数据、12 次未经授权 MCP、12 次小规模并发元数据；P50=242ms、P95=568ms、P99=620ms；不重复 CF-R 30 分钟 360/360 与 SSE 600 秒研究 |
| P9 回归/文档/Git | VERIFIED（本地回归） / Git 交付进行中 | C5-N8 全量测试 **54/54 PASS、0 fail、退出码0**；Windows signal-only 用例与 OAuth loopback trust-proxy 改动均通过；Git SHA 于交付后核验 |

## 实机问题和最小修复

1. 首次真实 `console [8]` 重启返回 `NAMED_PROCESS_STILL_RUNNING`。原因是 Windows 子进程通过 signal 结束时 `exitCode` 仍为 null，旧判断未同时检查 `signalCode`。仅改 `cloudflare-named-agent.mjs` 的子进程存活判断，保留原有无法确认进程退出时的拒绝接管保护。新增信号结束专项测试；修复后真实 `[8]` 重启及公网复核成功。
2. Cloudflare 请求设置 X-Forwarded-For 时，Express 限流组件输出 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 警告。OAuth Gateway 仅在 `127.0.0.1` 监听，故仅对回环代理设置 `trust proxy='loopback'`，没有对任意来源开放代理头信任。
3. 与公网实际授权和工具调用相关的临时测试脚本、请求日志及校验数据位于 Git 忽略的 `test-runtime`，未引入公网 Token 到公开代码或文档。

## 仍待执行 / 不计入本轮已通过

- **C5-L5 官网验收：PENDING_HUMAN_INPUT。** 独立测试客户端的真正 OAuth+MCP 已通过，但这不是官方 Gemini 网页的真实连接、发现、调用和结果回传。需要用户在 Gemini 网页中添加 `https://gemini.venpenmen.dpdns.org/mcp`，提供网页所显示的精确 Google OAuth 回调，在本机替换测试回调并预授权，再进行网页工具发现/读写/权限回归。
- **Full/terminal 官网验收：PENDING_EXPLICIT_APPROVAL。** 需用户明确二次授权，Restricted 文件权限不等于终端 OS 沙箱。
- **故障注入范围：DEFERRED_MAINTENANCE。** 跨 SakuraCat 四组合、日新节点切换、真实断网与 Windows 重启留维护窗口，避免影响其他任务。QUIC → HTTP2 故障回退未单独强制注入。
- **连接器常驻边界：** 当前处于测试控制台会话内受管运行，尚未安装系统服务、自动开机启动或统一 C6 管理。关闭控制台会停止实例，按 C5-N-HANDOFF.md 可恢复。

## 交付前安全清场

公网 Refresh Grant 测试完成后已调用真实 /revoke 并确认旧 Bearer 401。随后停止正式受管实例，验证 owner.lock、cloudflare-named-owner.json 和临时 plaintext Token 均已清理且 18767 不再监听；仅在校验 OAuth 状态确属本轮临时回调且 Refresh Grants 已全部撤销的前提下，清理该测试 OAuth DPAPI 状态。独立 Named DPAPI Tunnel Token 保留。再次启动正式实例后：OAuth clientRegistered=false，Restricted/14、18767、Named public ready/verified=true。用户不必再次配置 Cloudflare 或复制 Tunnel Token。

下一步由用户进入 Gemini 官方网页自定义 MCP 设置并使用 `https://gemini.venpenmen.dpdns.org/mcp`；将实际网页返回的精确 Google redirect URI 提供给本地控制台 [4] 注册，并仅在本机界面通过 [6] 获取 OAuth client ID/secret 填入 Gemini，随后 [5] 临时授权。网页实际 `tools/list`、只读文件调用、结果回传与刷新/重连验收属于 C5-L5，由用户授权的网页操作完成。不要向聊天发送 OAuth 凭据、Token 或 Cookie。
