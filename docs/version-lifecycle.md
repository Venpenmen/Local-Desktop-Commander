# B5-CORE 版本生命周期公共契约（候选）

## 范围与基线

- 公共维护支线 `feature/b5-version-lifecycle`，从 `develop` 的 `e2addd05387323b19eb4c97ddf0af125717accc0` 派生。
- 仅修改公共 PowerShell 5.1 JSON stdio 管理核心及最小必要的 local-dev 启动适配，保持 v1 协议、每请求独立子进程、同实例互斥、确认和 Revision 保护。
- `main` / `v1.0.0` 继续冻结；正式 OpenAI 隧道、用户凭据、网络配置和 Gemini 工作区不得修改。
- 管理实例 ID、目标版本、回滚记录和实际进程状态分别核对；启动成功、healthz/readyz、MCP 发现和真实远程调用不是同一层验证。

## 新增操作

| 操作 | 参数 | 行为 |
| --- | --- | --- |
| `version.install` | `confirmed:true`, `revision`, `path`（本机 ZIP 绝对路径）, `sha256`（独立取得的可信 SHA-256） | 在本实例管理互斥下校验归档、manifest、每文件 SHA，临时目录安装，原子登记新的未启用版本。不停止或改变现有服务。 |
| `version.verify` | `id` | 只读核对管理注册表中固定的 manifest SHA 与安装后的不可变文件哈希。返回 `verified/modified/unmanaged`。旧 P6 没有发行包证明时返回 `unmanaged`，不是伪造可信。 |
| `version.activate` | `confirmed:true`, `revision`, `version`, `mode`（files / terminal） | 要求当前实例真实运行并有健康与 MCP 工具发现快照；新版本先通过完整性检查，沿用共享受控切换。切换后验证目标 PID、版本、模式、healthz/readyz、工具数。失败时尝试恢复旧版，区分成功恢复与恢复失败。 |
| `version.remove` | `confirmed:true`, `revision`, `id` | 仅允许删除非活动、非目标、非回滚、非默认且由本安装器管理的版本。检查重解析路径，先隔离目录再写注册表，不删除受保护或未知版本。 |

## 候选 ZIP 约束

ZIP 根目录必须含 `ldc-package.json`（schema=1），其字段固定包括：

```json
{
  "schema": 1,
  "id": "canarya",
  "label": "Canary A",
  "directory": "versions/canarya",
  "launcher": "LocalDC.ps1",
  "profile": "profile.local.yaml",
  "runtime": "runtime",
  "build": "upstream/dist/index.js",
  "rootConfig": "allowed-root.txt",
  "rootValidator": "stdio.mjs",
  "filesTools": 14,
  "terminalTools": 21,
  "files": [
    {"path": "LocalDC.ps1", "sha256": "64 lowercase hex"}
  ]
}
```

`files` 要列出所有非目录条目，且必须包含 `LocalDC.ps1`、`stdio.mjs`、`upstream/dist/index.js`。每个 SHA-256 必须是按实际字节计算的十六进制摘要。用户提供的 ZIP 总摘要必须来自**可信独立来源**，仅计算同一 ZIP 的摘要无法证明代码来源。

ZIP 验证限制：最多 2 GiB ZIP、4 GiB 展开总量、2000 条目、单文件压缩比上限、16 KiB manifest、每文件哈希、大小写冲突、绝对路径、盘符、路径遍历和符号链接拒绝。解压只进入当前实例下 `versions/.ldc-staging-*`，哈希验证后移动到 `versions/<id>`，并通过共享管理器登记。失败后清理临时目录，不移动或覆盖原有版本。

已安装清单固定到管理版本注册表，并留存 manifest 的独立 SHA-256。检查器校验不可变负载；允许授权根、访问模式、代理本地配置和 profile 在运行期间合法更新，这些可变字段被明确排除在不可变文件哈希检查之外。

## 启动与失败恢复

- local-dev 的 P6 使用原 `node engine/stdio.mjs --tunnel`；经管理器安装的新版本使用 `node versions/<id>/stdio.mjs --tunnel`，进程身份核验同时确认该入口与目标版本一致。
- 初次安装**不启动**。已注册与已安装不等于运行/真实 MCP 可用。
- `version.activate` 的健康与工具数量为本地可观测门禁，仍须独立的 MCP `tools/list`/实际 `tools/call` 验证，不代表远程 ChatGPT/Gemini 调用。
- 测试专用版本 `canarya`、`canaryb` 使用合成可控进程来验证受控切换、故障回滚和进程隔离，不把合成健康端点当作真实 MCP 服务器。
- 停止服务前严格验证 PID、birth、实际来源与 pending。进程归属不明即拒绝自动修复，不跨实例终止进程。升级失败时执行受控回滚，返回 `UPGRADE_ROLLED_BACK` 或 `RECOVERY_FAILED` 并保留可诊断任务与事件。

## 交付和剩余边界

真实跨版本 MCP 引擎升级的最终证明需要**两份真实、各自可运行且内容独立的发行候选**，并进行 MCP 完整工具名单和调用验证。OpenAI hosted 的公网及凭据复验需要独立维护窗口。没有发行方可信的下载清单时不添加自动网络下载/无人值守升级。

公共候选通过独立夹具、原管理/TUI 与隔离 MCP 回归后合入 `develop`，再经分支保护同步 GUI/Gemini。新端操作需检查 `capabilities.operations`，旧协议未支持时隐藏对应操作。不得直接修改任何客户端的私有版本注册表。
