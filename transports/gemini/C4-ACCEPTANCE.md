# M7-C4 本地完整工具与权限适配验收

当前分支：`feature/gemini-web`。验收对象：`transports/gemini` 独立本地 MCP 适配器，复用固定版本原生 `engine/stdio.mjs` 和 M7-ACCESS。完整的 Gemini 官方网页 OAuth 与公网访问另在 C5 验收；公共管理协议与 GUI 注册另在 C6/C7 完成。

## 执行清单

| 阶段 | 目标 | 证据 |
|---|---|---|
| C4.0 | 对 C3 原59项逐条核销 | `C3-AUDIT.md`（56 PASS、3 DEFERRED C5）及 C4 原生超时注入 |
| C4.1 | 原生 Schema 动态注册与结果转发 | `bridge.mjs` + SDK 低层 `Server`、动态工具清单与真实调用 |
| C4.2 | 14项文件工具 | `c4-tools.test.mjs` 逐项执行；PDF 原生编辑支持 |
| C4.3 | 7项终端工具 | 真实子进程启动、交互、输出、会话、停止及清理 |
| C4.4 | Restricted/Full 双模式 | `c4-matrix.test.mjs` 四模式真实回归 |
| C4.5 | 配置、持久化、生命周期 | `cli.test.mjs`、`c4-security.test.mjs`、`c4-lifecycle.test.mjs` |
| C4.6 | 联合安全与实例隔离 | Junction/ADS、控制文件保护、令牌与跨域、异常、超时、双实例 |
| C4.7 | 工程管理、提交与交接 | 状态文件、变更审查、分支提交和远端 SHA 对齐 |

## 四模式矩阵

| 文件权限 | 工具模式 | 原生数量 | 验收点 |
|---|---|---:|---|
| Restricted | files | 14 | 根内读写成功；根外、Junction、ADS 拒绝 |
| Restricted | terminal | 21 | 文件根保护有效；终端仍按 Windows 当前用户运行 |
| Full | files | 14 | 本机磁盘访问；原生安装控制文件仍不可写 |
| Full | terminal | 21 | 本机文件访问、终端能力与控制文件保护 |

完整21项原生工具名称：

`read_file`、`read_multiple_files`、`write_file`、`write_pdf`、`create_directory`、`list_directory`、`move_file`、`start_search`、`get_more_search_results`、`stop_search`、`list_searches`、`get_file_info`、`edit_block`、`start_process`、`read_process_output`、`interact_with_process`、`force_terminate`、`list_sessions`、`list_processes`、`kill_process`、`get_usage_stats`。

每一项均通过真实原生 MCP 调用执行；仅对原生 PDF 工具的创建与编辑能力作区分：**原生 Local DC 配置禁止 Markdown→PDF 渲染，PDF 页面编辑成功**，本阶段不改变上游保护策略。

## 实际防护范围

- 仅绑定 `127.0.0.1`；未通过公网隧道传播 C4 Bearer。
- 每次启动签发新的随机本机 Bearer，不能使用旧令牌连接新实例；无效或缺失令牌 HTTP 401。
- 非白名单工具被拒绝；工具参数 Schema 原样来自原生 MCP 引擎，文件权限由原生引擎判定。
- Full 模式、终端模式必须本地显式确认风险；切换实际权限前先停止并启动实例。
- **Restricted 限制文件工具，不限制终端命令的 Windows 用户权限。** `Restricted + terminal` 的真实测试证实终端能读取同一用户可访问的根外测试文件。前端应明确提示。
- 原生引擎放在 `instance/install/engine`，测试工作区放在同级 `instance/workspace`；原生安装文件保护继续生效。
- 独立 `owner.lock` 防止两个进程接管同一实例；异常退出时回收过期锁，不结束未知 PID。
- 运行日志限量轮换、白名单字段脱敏；不落盘令牌或文件正文。
- 终端验证只启动和结束本次独立引擎创建的测试会话，不影响主 LDC、正式 ChatGPT 连接或 GUI 分支。

## 关联测试与范围

`node --test --test-concurrency=1 *.test.mjs` 在 `transports/gemini` 下运行 C3+C4 关联测试。`experiments/gemini-web-c2` 的既有 OAuth/探针/文件读取测试另行复验。公共 M7-ACCESS 引擎未修改，沿用已通过的四模式原生矩阵及 managed access 回归。

C4 只完成 **本地能力**。C5 集成官方 Gemini 网页 OAuth 和 HTTPS；C6 在公共分支完成共享管理/扩展注册；C7 联合 GUI 验收。详见 `COMMON-INTEGRATION.md`。


## C4 最终本地回归记录（2026-11-28）

- `npm.cmd test`：**18/18 PASS，0 失败**，涵盖 C3 基线、四模式、21项逐工具调用、原生 deadline、CLI 增权确认、日志、崩溃恢复及双实例隔离。
- C2 历史实验回归：**6/6 PASS**，未修改其原始实验代码。
- 固定依赖离线重装 `npm.cmd ci --offline --ignore-scripts --no-audit --no-fund` 成功，重装后 MCP 冒烟测试 **2/2 PASS**。
- 存在已记录的原生功能限制：Markdown→PDF 创建在固定上游 Local DC profile 下拒绝；PDF 页面编辑成功。该限制不是 Gemini 桥接错误。
- 产物为独立本地开发适配器；C5/C6/C7 的真实公网授权、统一管理和 GUI 接入仍需后续验证。
