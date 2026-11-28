# C5-N 正式连接器验收记录

## 范围

2026-11-28，工作区 feature/gemini-web，开始基线 HEAD e3a532777eebea8bd03620f523271f1e2300e78f（clean）；独立研究 CF-R5.3 360/360、SSE 600 秒为历史基础设施证据，不重复研究网络服务商。只修改 Gemini 分支，Core/develop、GUI/feature/management-gui、main/v1.0.0 和正式实例不改动。

## 本地测试矩阵

| 项目 | 验收含义 |
|---|---|
| N0 | 历史证据/规范/实际 Git baseline 核验 |
| N1 | C5-U Provider 从 reserved 切换 local，经理工厂接入，旧供应商继续兼容 |
| N2 | Issuer 与固定 localPort 校验、配置 revision、单独 DPAPI、Windows ACL 和可信签名/哈希 |
| N3 | 受管进程只使用 --token-file，独占锁、所有权、重复启动拒绝和本实例清理 |
| N4 | 退出后退避有限重试、永久失败 blocked、意外遗留进程拒绝误杀 |
| N5 | OAuth 授权服务器和资源元数据、401 Bearer 未授权拒绝，HTML/重定向/授权失败不伪装 ready |
| N6 | 控制台配置、Token 隐藏输入、状态与 CLI 旧协议兼容 |
| N7 | 原测试全量、C2 历史回归、离线依赖、Node 语法、Git 安全范围 |
| N8 | 真实专属 Named Tunnel + Public Route + 真实公网 OAuth/MCP + 官方 Gemini 网页 L5 |
| N9 | 文档、断点、Git 校验、提交与远端推送 |

## 主要新增定向用例

cloudflare-named-agent.test.mjs：精确 OAuth 元数据与未授权拒绝；Token 文件生成、无回显与清理；跨本地实例同 Issuer 排他；Agent 异常退出有限重连；创建失败清理；真实 Windows Authenticode、SHA256、ACL；本地原生 MCP/OAuth 及固定端口重启、OAuth 注册保留；孤儿记录安全拒绝及死亡进程清理；无法确认退出时保留所有权；重试耗尽阻止无限启动；localPort 有效性。

注意：真实 Windows ACL 和签名验证并不等于已使用真正 Named Token 执行公网 MCP；模拟进程只证明本地生命周期，不替代 L3/L5。

## 交付状态与边界

本轮 Gemini 全量 npm test **53/53 PASS、0 fail**（新增 Named 11/11）；C2 历史浏览器/OAuth/原生 MCP **7/7 PASS**；离线 npm ci 安装 95 包后独立烟测 **7/7 PASS**；Node 语法检查与实际 Windows 签名/ACL 校验通过；Named Console 的 Provider 选择、固定域名与默认端口配置、状态显示和 Q 退出实机 PASS。真实 Cloudflare ldc-gemini 账户控制台操作、独立 Token 本地导入、Published Route、真实 OAuth/MCP 与 Gemini 官方网页联调等待用户操作后验收，保持 PENDING_HUMAN_INPUT。QUIC 故障注入、SakuraCat 全模式/节点、整机断网与系统重启属于 DEFERRED_MAINTENANCE。历史 HTTP 502 与频繁连接器注册/退出存在相关性但尚未证明唯一因果。

## 与既定 25 项验收列项的映射

| 编号 | 当前状态 | 证据及未完成边界 |
|---|---|---|
| N-T01 | VERIFIED | HTTPS Issuer 合法性与非法域名拒绝 |
| N-T02 | VERIFIED | Tunnel ID、固定 localPort 与配置修订 |
| N-T03 | VERIFIED | Windows DPAPI 真实保存、读取与隔离 |
| N-T04 | VERIFIED | Windows 文件 ACL 受保护，仅当前用户与 SYSTEM |
| N-T05 | VERIFIED（本地） | 状态、回归及源码敏感内容扫描；Git 暂存复核见交付记录 |
| N-T06 | VERIFIED | cloudflared.exe 2026.11.2 签名、SHA256、--version |
| N-T07 | VERIFIED（本地） | 单实例及相同 Issuer 的共享运行根排他，重复启动拒绝 |
| N-T08 | PENDING_HUMAN_INPUT | 真正 Named Token 启动/停止公网连接器，未借用研究 Token |
| N-T09 | PARTIAL | 存活孤儿拒绝接管、无法退出保留锁；真实 PID 重用/外部进程未故障注入 |
| N-T10 | VERIFIED（本地） | mock Agent 异常退出、有限次数重启与 blocked |
| N-T11 | PARTIAL | 健康探测状态降级/恢复逻辑；实际断网留维护窗口 |
| N-T12 | VERIFIED（本地） | 正常/异常/模拟崩溃 Token 清理；真实整机崩溃待维护窗口 |
| N-T13 | VERIFIED（本地） | 固定 Issuer 与 localPort 重启保持；Cloudflare 真实重启待验 |
| N-T14 | VERIFIED（本地） | OAuth 服务器与受保护资源元数据验证；公网端点待测 |
| N-T15 | VERIFIED（本地） | 401 Bearer 未授权拒绝；真实 Cloudflare 路径待测 |
| N-T16 | PARTIAL | 既有真实本地 native MCP/OAuth 成功；Named 公网工具调用待测 |
| N-T17 | VERIFIED（本地） | 既有 Restricted/Full × 14/21 权限矩阵回归 |
| N-T18 | VERIFIED（本地） | OAuth 注册与固定域名重启保留；官方 Gemini 会话待测 |
| N-T19 | VERIFIED（本地） | 历史 OAuth 无效/撤销令牌拒绝回归 |
| N-T20 | VERIFIED | ngrok / Quick / External HTTPS 关联回归 |
| N-T21 | VERIFIED | 本轮 Gemini 全量 53/53 PASS |
| N-T22 | VERIFIED（本地） | CLI 协议、Named Console 实际配置与退出 |
| N-T23 | VERIFIED（隔离） | 同运行根重复连接器拒绝；研究与生产实例未改动 |
| N-T24 | VERIFIED（本地） | Git 范围、diff --check 与秘密信息扫描；暂存提交前复核 |
| N-T25 | 交付检查点 | 文档、忽略证据、branch commit/push 与 SHA 校验，以 Git 验收为准 |

最终 C5-N 真实公网启动和 Gemini 官方网页 L5 只有拿到独立 Tunnel、Route、Token 并由用户在官方网页进行授权与工具调用后才能转为 VERIFIED。涉及全局代理、节点、断网、Windows 整机重启的验收保持 DEFERRED_MAINTENANCE。
