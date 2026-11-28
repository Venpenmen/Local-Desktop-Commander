# C3 原59项清单逐项收口（C4.0）

核验对象：Gemini `feature/gemini-web`，基线 `62f4cf454b6773f803933fd620aa5fa3d7609818`。本次复核结合 C2 原始验收证据、C3 已提交代码以及 C4 补齐的动态工具、实例隔离、日志、故障注入和权限测试。

**结果：PASS 56 / 59，DEFERRED 3 / 59。** 三项 OAuth/公网依赖划入 C5，没有作为已验收的正式 Gemini 公网能力。C3 的本地工程化收口已完成，正式产品的 C5/C6 依赖仍独立管理。

| 编号 | 原列项 | 核销 | 依据/去向 |
|---|---|---|---|
| C3.0.1 | 读取工程断点 | PASS | AGENTS、STATE、TASKS |
| C3.0.2 | 检查三个工作区及分支 | PASS | worktree、HEAD、干净状态 |
| C3.0.3 | 核对 C2 验收证据 | PASS | C2 网页证据与日志 |
| C3.0.4 | 检查实验残留进程 | PASS | 已有专属实验实例停机 |
| C3.0.5 | 超时故障注入 | PASS | C4 原生 MCP 截止时间测试 |
| C3.0.6 | 同步 Gemini 分支至 GitHub | PASS | C3 远端 SHA 核对 |
| C3.1.1 | 精读 OpenAI 适配器 | PASS | OpenAI 管理入口及 profile |
| C3.1.2 | 精读公共实例管理 | PASS | M7 管理 API、实例与扩展契约 |
| C3.1.3 | 定义 Gemini 适配器职责 | PASS | ARCHITECTURE.md |
| C3.1.4 | 定义配置文件 | PASS | config.mjs / target.json |
| C3.1.5 | 定义生命周期 | PASS | runner.mjs / cli.mjs |
| C3.1.6 | 定义错误与状态 | PASS | state、revision、error code |
| C3.1.7 | 编写架构设计 | PASS | ARCHITECTURE.md |
| C3.2.1 | 提取可复用 OAuth 模块 | DEFERRED | C5 需集成 C2 验证过的 OAuth，当前 C4 不承载公网 |
| C3.2.2 | 提取 Streamable HTTP 网关 | PASS | gateway.mjs（回环） |
| C3.2.3 | 重构动态 stdio 桥接 | PASS | 原生工具发现、14/21 Schema |
| C3.2.4 | 统一原生 MCP 请求响应 | PASS | 低层 Server 保留原生结果 |
| C3.2.5 | 工具注册与过滤 | PASS | 动态 allowlist，非名单拒绝 |
| C3.2.6 | 建立安全日志 | PASS | audit.mjs，脱敏与限量轮换 |
| C3.2.7 | 保留 C2 实验源码 | PASS | C2 6/6 回归通过 |
| C3.3.1 | 独立 Gemini 实例目录 | PASS | test-runtime 独立实例 |
| C3.3.2 | 实例标识 | PASS | 独立 ID 与 owner.lock |
| C3.3.3 | 独立运行状态与日志 | PASS | state/target/logs |
| C3.3.4 | 公共文件访问权限 | PASS | 复用 engine/stdio.mjs |
| C3.3.5 | 工具模式配置 | PASS | 14/21 模式切换 |
| C3.3.6 | 非法配置拒绝 | PASS | root、schema、mode、tools 验收 |
| C3.3.7 | 实际与目标配置 | PASS | fileAccess.actual/target/restartRequired |
| C3.3.8 | 敏感信息保护 | PASS | 临时令牌未落盘、日志脱敏 |
| C3.4.1 | 启动入口 | PASS | runner.start、CLI |
| C3.4.2 | 停止入口 | PASS | runner.stop、原生 child 清理 |
| C3.4.3 | 重启入口 | PASS | runner.restart、令牌更新 |
| C3.4.4 | 进程身份与误杀防护 | PASS | 独占实例锁、仅关闭已创建子进程 |
| C3.4.5 | 引擎异常退出处理 | PASS | 故障返回、下一实例恢复 |
| C3.4.6 | 超时与并发 | PASS | 真实 MCP timeout、限流与请求限制 |
| C3.4.7 | OAuth 会话隔离 | DEFERRED | C2 探针已测，正式适配器的授权会话属 C5 |
| C3.4.8 | 扩权后授权处理 | PASS | C4 本地明确确认、停止后变更、令牌轮换；公网 OAuth 重授权属 C5 |
| C3.4.9 | 公网隧道状态检测 | DEFERRED | C5 固定/临时公网入口及诊断 |
| C3.5.1 | 配置加载 | PASS | 配置回读测试 |
| C3.5.2 | 非法配置 | PASS | 安全测试 |
| C3.5.3 | MCP 初始化 | PASS | 实际 HTTP→stdio 连接 |
| C3.5.4 | 动态工具发现 | PASS | 14/21 工具列表验收 |
| C3.5.5 | 原生文件读取 | PASS | 随机夹具逐项调用 |
| C3.5.6 | Restricted 越界拒绝 | PASS | 目录外、Junction、ADS |
| C3.5.7 | 非白名单工具拒绝 | PASS | MCP tools/call |
| C3.5.8 | OAuth 安全回归 | PASS | 保留 C2 OAuth 既有测试 6/6（非 C3 公网部署） |
| C3.5.9 | 超时故障注入 | PASS | 原生请求 timeout |
| C3.5.10 | 引擎崩溃或明确报错 | PASS | fault.test.mjs |
| C3.5.11 | 启停及重启 | PASS | CLI、父进程退出清理 |
| C3.5.12 | 双实例隔离 | PASS | 各自 PID、令牌、文件权限 |
| C3.5.13 | 正式服务无影响 | PASS | 正式部署运行进程独立 |
| C3.5.14 | C2 历史回归 | PASS | 六组历史实验通过 |
| C3.6.1 | 全量源码差异审查 | PASS | 仅 Gemini 支线受影响 |
| C3.6.2 | 敏感信息扫描 | PASS | 暂存内容、日志及运行密钥边界 |
| C3.6.3 | 架构文档 | PASS | ARCHITECTURE.md |
| C3.6.4 | STATE、TASKS | PASS | 各自本地断点 |
| C3.6.5 | 交接说明 | PASS | C3/C4 验收记录 |
| C3.6.6 | Git 提交与推送 | PASS | C3 提交 62f4cf4 |
| C3.6.7 | 公共模块变更提案 | PASS | COMMON-INTEGRATION.md |
| C3.6.8 | C4 开发断点 | PASS | C4 测试、配置与回归记录 |

## 不跨阶段计为通过的三项

`C3.2.1`、`C3.4.7`、`C3.4.9` 与正式 Gemini OAuth/公网能力直接相关，统一进入 **C5**。共享公共管理协议的正式适配器注册依照 `COMMON-INTEGRATION.md` 在 **C6** 执行。

**安全边界：** 以上已通过的是本地独立适配器及继承的 C2 网页验证，不表示 C4 的完整工具集已经在 Gemini 官方网页发布。
