# C5-L5 Gemini 官网及权限切换验收（2026-11-28）

## 范围与事实边界

工作区 `feature/gemini-web`，前序提交 `c9b2ace650df557f1d7d1a985b1fb70e366246e9`。独立 Named Tunnel 公网入口 `https://gemini.venpenmen.dpdns.org/mcp`，本地固定 OAuth Gateway `127.0.0.1:18767`；仅操作 `test-runtime/gemini-personal/ldc-gemini` 和隔离的自动化测试实例。不修改生产、Core、GUI、main、全局代理/TUN、研究 Tunnel；没有安装 Windows 服务，也没有执行整机重启。

此次真实 Gemini 官网 L5 证据来自用户在 Gemini 官网实际执行并提供的工具返回报告，结合独立 Windows 文件系统与本实例 `logs/events.ndjson` 实机审计核对。LDC 无权直接检索 Gemini 官网内部客户端工具挂载表；工具清单及旧/新对话对比不能当作 Google 内部实现证明。独立本地 MCP 回归只用于补充验证，不冒充官网 L5。

## 验收结果与证据

| 检查点 | 判定 | 实际证据 |
| --- | --- | --- |
| L5-01 官网安装及 OAuth | VERIFIED | 用户在 Gemini 官网完成 `Local DC Gemini Adapter` 关联，Google 精确回调注册在本地，实际颁发 Access/Refresh Grant；服务端有 `oauth-access-issued` 审计。Client ID/Secret 不写入本文档。 |
| L5-02 Restricted / Files（14）官网 | VERIFIED | 用户在官网发现14文件工具；`read_file` 读取 `c5n8-public-probe.txt` 返回预期标记，官网 9 项目录创建/读写/编辑/属性/移动/Restricted 越界访问报告与服务端审计一致。 |
| L5-03 文件系统独立复核 | VERIFIED | `L5-test/verified.txt` 存在且内容 `L5-EDIT-PASS`；原 `verification.txt` 不存在；既有 `c5n8-public-probe.txt` 未改变；5/5 独立核验。 |
| L5-04 Restricted / Terminal（21）官网 | VERIFIED（核心工具） | 用户重新关联并开新对话后发现21项，7个终端工具全部在声明中出现；`start_process` PowerShell 输出 `L5-TERMINAL-PASS`，PID 56168 正常结束；`read_file` 成功、越界 `list_directory` 拒绝。服务端 `2026-11-28T15:02:40.788Z` read_file 成功、`15:02:41.100Z` list_directory 错误、`15:02:45.614Z` start_process 成功。其余6个终端工具本轮官网仅发现，未逐一官网实际调用；C4 本地测试已覆盖。 |
| L5-05 官网旧/新对话差异 | OBSERVED | 用户实际发现：权限变化并重新关联后，旧对话 Adapter 为0工具且调用 `INVALID_ARGUMENT`，新对话发现21工具且运行成功。同一 Adapter 标识。缓存/挂载原因只是推断，尚无官方内部证据；本阶段明确指引重新关联并新建 Gemini 对话。 |
| L5-06 正式实例 Full / Files | VERIFIED（服务层） / 官网未验 | 控制台停止、`[7]` Full+14、显式 `ENABLE`、`[3]` 启动及 `[11]` 公网 verified，状态 `full/files/14`，旧 Access/Refresh 数量0。未重新关联 Gemini 官网执行 Full 文件访问。 |
| L5-07 正式实例 Full / Terminal | VERIFIED（服务层） / 官网未验 | 同样停止、切换 Full+21、显式确认、启动及公网 verified，状态 `full/terminal/21`，旧授权数量0。未重新关联官网执行该模式的工具。 |
| L5-08 本地四模式真实工具矩阵 | VERIFIED | `node --test c5-permissions.test.mjs c4-matrix.test.mjs` 实测 6/6 PASS，exit0；C4 原生四模式实际文件内外访问、工具数量与真实终端，C5 OAuth 四模式、提权失效、重新授权 PASS。 |
| L5-09 正常重启与失效 | VERIFIED（本地） | Restricted/Terminal 下受管控制台 `[8]` 正常重启，Named 公网 ready/verified 保持21工具；同模式重启后 DPAPI refresh 条目保留。本次没有借用该条目执行新的官网刷新请求；先前 C5-N8 独立真实公网客户端已验证 refresh-after-restart。权限变化 `oauth-scope-invalidation` 审计累计可见，旧 Access/Refresh 清零。 |
| L5-10 降权恢复 | VERIFIED（服务层） | 切回 Restricted / Files 后状态 `running/restricted/files/14`、local MCP ready、公网 ready/verified、OAuth 客户端注册保留，旧 Access/Refresh 均为0。此时 Gemini 官网既有授权需重新关联/授权后才能复用。 |
| L5-11 定向与完整回归 | VERIFIED | 定向6/6 PASS，exit0；完整 `npm.cmd test` 54/54 PASS、fail0、exit0，日志位于被 Git 忽略的 `test-runtime/gemini-l5-final-regression.log`。 |

## 权限切换实际行为与客户端操作

- `[9]` 停止受管实例 → `[7]` 选择四种文件/终端组合 → 风险组合显式输入 `ENABLE` → `[3]` 启动并确认 → `[11]` 公网验证。
- 目标权限变更导致 OAuth 配置 revision 变化，旧 Access/Refresh Grant 在下一次启动时失效；OAuth 客户端本身仍注册，固定 Issuer 和 Named Tunnel DPAPI 凭据保留。旧 Gemini 对话出现工具挂载0的实际现象，重新关联 + 新对话能够恢复发现。
- Restricted 文件工具限制授权根目录，但 Terminal 运行于当前 Windows 用户权限，不是文件目录沙箱；官网每个工具另有 Gemini 许可提示。保留服务端显式提权确认与旧授权失效，不以无感切换为理由取消保护。
- 下一阶段 C6/C7 可显示目标/实际权限、工具数量、公网/授权状态，在模式切换后提示“重新关联并新建 Gemini 对话”。不为本次发现改动核心 OAuth、GUI 或生产。

## 最终状态、安全与遗留

本轮结束后测试实例保持 `Restricted / Files` 14 工具，Named 公网 ready/verified，控制台仍由原隔离进程管理；未安装自启服务，不建议认为 Windows 重启后自动恢复。OAuth Manual 客户端注册仍在，Access/Refresh grants 为0。先前曾在聊天中展示过 Client Secret，**已暴露的客户端密钥尚未轮换**；正式继续长期使用前应在本机轮换并由用户在 Gemini 官网更新配置、重新关联。当前无有效授权令牌。不得将凭据、私有 Windows 路径以外的秘密、测试日志或 DPAPI 文件加入仓库。

**范围外待办（不宣称完成）：** 官网 Full / Files 与 Full / Terminal 真实工具调用、同一官网对话静默刷新及服务重启后恢复、Client Secret 安全轮换后的官网重新关联、跨全局代理模式/日新节点切换/真实断网/整机重启。前三项需 Gemini 官网用户交互，后四种网络/系统干预留维护窗口；独立本地与先前真实公网 SDK 已有对应回归，不阻塞 C5 本地交付，**C5 官网全矩阵仍为 PARTIAL**。

Git 交付只包含本文件与小范围交接/变更日志；不包含 `test-runtime`、DPAPI 文件、Token、客户端密钥。