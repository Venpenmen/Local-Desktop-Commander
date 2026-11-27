# Local Desktop Commander 路线图

## 稳定基线：v1.0.0（2026-11-27）
已正式公开发行，main 与 v1.0.0 标签冻结。Windows ChatGPT MCP、14/21 工具模式、TUI、独立部署和 MIT 原创代码许可已交付。历史即时跨部署回滚退役为冷归档；延期的破坏性复验不作为发行阻塞，不宣称其通过。

## 当前：M7 管理平台与客户端扩展
| 阶段 | 状态 | 范围 |
| --- | --- | --- |
| M7-A | VERIFIED | 统一管理核心、JSON stdio API v1、OpenAI 适配器、扩展契约、TUI 迁移及双实例隔离 |
| M7-B | IN_PROGRESS | 独立 GUI，先基础界面与共享管理，再连接、异常恢复、日志、配置、更新、扩展管理 |
| M7-C | IN_PROGRESS | Gemini 官方网页版接入条件调研、最小真实连通、适配器及扩展封装 |

M7-B 与 M7-C 独立分支并行，共享 develop 公共契约。GUI 可以先发行 v1.0.x；Gemini 真实接入成熟后再集成为 v1.1.0。界面简洁，GUI/TUI 共享状态、操作及锁；GUI 稳定后旧 TUI 归档，保留 CLI。Gemini 网页版接入机制尚须实证，不以 API 或 CLI 替代目标。

公共变更经维护分支、契约验收、develop 集成后同步两线。具体任务和证据在各工作区本地 STATE.md、TASKS.md；初次克隆参见 docs/m7-handoff.md。

## 后续
v1.2.0 候选方向：Antigravity 等客户端，按实际接入能力验证。长期目标为统一 MCP 引擎、可扩展传输及管理平台。版本号与发行节奏以实际验收为准。
