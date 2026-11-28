# C5-U 统一公网隧道接口验收记录

## 验收范围与边界

目标为 Gemini 独立分支的 C5-U0–C5-U8：统一公网 Provider 契约、运行器迁移、动态域名安全绑定、独立凭据、控制台、定向测试、工程交付。与此不同，C5 全面公网和 Gemini 官方网页 L5 需要真实服务商账号/域名及用户在 Gemini 网站操作，仍为后续专项任务。

自动测试源码位于 transports/gemini，真实运行证据仅在各实例的被 Git 忽略的 test-runtime 目录，不提交令牌、日志或测试产物。

## 12 组新增专项测试

| 编号 | 范围 | 验收方法 |
|---|---|---|
| T01 | Provider 配置与 capability | schema、固定/动态地址、非法域名/凭据拒绝 |
| T02 | 统一管理生命周期 | factory、start/stop/restart/recheck，隔离所有权 |
| T03 | 旧 ngrok 与外部 HTTPS | 旧 C5 兼容，外部探测无进程归属 |
| T04 | Named 预留 | 能力声明 reserved，启动明确拒绝 |
| T05 | Quick Agent 域名解析 | 真实 stdout/stderr 模拟流分片与严格 trycloudflare.com 校验 |
| T06 | Quick Agent 退出/超时 | 界面 blocked、端点失效、只清理自有子进程 |
| T07 | 动态入口 503 屏障 | 启动 OAuth 前不可转发，绑定后真实回环 HTTP 转发 |
| T08 | 动态 OAuth 发行地址 | 实际原生引擎与 OAuth 元数据；新域名撤销旧 client/grants |
| T09 | 动态 URL 欺骗拒绝 | 非 Quick 域名 fail-closed，清理 bridge、lock、relay |
| T10 | 凭据与日志脱敏 | ngrok/Named 独立 DPAPI，无状态明文回显 |
| T11 | CLI 控制面 | provider get/set revision、RESET 二次授权、secret set/clear、Named 不可启动 |
| T12 | 并发启停和前置检查 | 预检只读、重复 start 失败、启动中 stop 取消并清理 |

测试文件：c5-unified-tunnel.test.mjs、c5-unified-cli.test.mjs、cloudflare-agent.test.mjs、tunnel-relay.test.mjs。

## C5-U0–U8 检查点

| 检查点 | 目标 | 状态 |
|---|---|---|
| U0 | AGENTS/STATE/TASKS/C5 交接与实际 Git 基线复核 | VERIFIED |
| U1 | Provider ID、能力矩阵、issuer/schema 校验与统一 API | VERIFIED |
| U2 | 实例独立持久化、修订号及 DPAPI 凭据隔离 | VERIFIED |
| U3 | 受管生命周期、状态、远程元数据探测、重复启动和退出处理 | VERIFIED（本地） |
| U4 | 固定/动态 OAuth 发行地址联动、变更撤销及 503 隔离 | VERIFIED（本地真实 HTTP） |
| U5 | ngrok 迁移、Quick 适配、Named 契约预留、External HTTPS | VERIFIED（本轮预定范围）；Named 真实 Agent 后续 |
| U6 | CLI/Console Provider 配置与状态、向 C6/C7 提供数据契约 | VERIFIED（本地） |
| U7 | 新增专项及 C2/C4/C5 回归 | VERIFIED：C5-U 14/14 PASS；C2 历史浏览器/原生 MCP 7/7 PASS；Gemini 全量 42/42 PASS（0 失败）；离线 npm ci 成功重装95包，语法检查通过 |
| U8 | 文档、断点、证据、分支 Git 提交/推送/生产隔离 | 本地证据/文档、16 个 Gemini 范围文件的 staged diff/secret 检查通过；旧正式健康地址不可达（未重启、未修改）；提交及远端 SHA 在 Git 交付后复核 |

## 不在本轮伪称完成的真实环境项

- Cloudflare Quick 本轮尚未重新创建实际公网试验 URL，也未用 C5-U 新运行器在 Gemini 官方网页完成 OAuth。
- Cloudflare Named 暂未提供 Tunnel Token、DNS Zone 或正式域名，真实 Agent 由并行专项研究决策后接入；现在会拒绝启动。
- ngrok Free 因用户账户注册网页 HTTP 403 尚无真实固定域名/Token，保留既有适配。
- 真实公网断网/重启及 Gemini 官方网页 14/21 工具、四权限模式验收，属于 C5 后续 L5 门槛。
- Quick Tunnel 不支持 SSE；C2 仅证明既有 JSON 基本协议可用于实际 Gemini 指定文件工具。
