# M7-B4 GUI 运维支持：日志、代理、凭据与首次引导

## 基线与边界

开发分支 `feature/management-gui`，继承 B3.1 `9c18e2f55a017a24bc0d99bc748bf3ff907a9f97`。仍为独立 GUI 开发候选，不改变正式 LDC 或 Gemini 代码、管理 API v1、权限规则、MCP 引擎与传输适配器。遵守 AGENTS.md 的进程归属、Revision、密钥安全与并行工作约束。

B4 重用 `management/LDC-CLI.ps1` 和现有 Windows 凭据交互脚本 `management/LDC-Stable.ps1`。无法仅凭本地 health、HTTP 检测或工具列表断言 ChatGPT/Gemini 远程实际连接成功。

## 日志中心

- 新增第 4 个导航项“日志中心”（整体导航共 5 页），输入来自已有 CLI `logs` 响应中的 `tunnel` 和 `events`。核心现有 API 每次仅返回最近 20 条结构化 tunnel 摘要及最多 40 条管理事件，不读取原始日志文件，不新增通用文件读取权限。
- GUI 只在进入该页或用户启动自动刷新时读取；日志限流为一次最多 200 条已缓存条目。定时轮询使用已有 GUI 三秒节奏；只在日志页打开并勾选自动刷新时执行。异常时保留上次摘要并显示读取失败，绝不自动修改服务。
- 提供来源、级别、文字筛选和“刷新日志”、复制、脱敏导出。仅缓存脱敏文本，原始日志内容以 SHA-256 摘要作为去重键；额外屏蔽常见凭据字段、Windows 绝对路径和 URL 查询字符串，导出只包含当前过滤结果。
- 日志中出现 ERROR 的事件只是管理历史，不能据此直接推断当前服务异常；实际状态仍由 `state` 和工具发现判断。
- 与 B3.1 导航及主题保持一致。概览、连接管理提供“查看日志”跳转。

## 代理与凭据

- 仅在 `instance.transport=openai` 时开放网络代理及 DPAPI 凭据管理；`gui/local-dev` 显示不适用且控件禁用。能力以真实管理契约约束，不扩展到 Gemini 或其他未支持传输。
- 代理目标仅支持自动选择（`proxy:null`）或 loopback HTTP `http://127.0.0.1:1..65535`（接受 localhost，保存时归一化）。拒绝公网地址、凭据型 URL、SOCKS、HTTPS 协议和非法端口。点击测试调用已有只读 `diagnose`；点击保存时要求确认、比较此前读取的 `configuration.revision`，再调用 `network.set`。不修改系统代理、TUN、全局环境或其他实例。修改后由用户决定是否手动重启，不宣称运行中的实际代理已发生变化。
- 当前公共 JSON CLI 明确将 `credential.configure`、`credential.forget` 限制为 `INTERACTIVE_REQUIRED`。B4 的安全凭据按钮只在用户明确点击和确认后打开既有 `LDC-Stable.ps1 -Action Configure/Forget` 的交互式 PowerShell，沿用 `Read-Host -AsSecureString` 和 Windows DPAPI；GUI 永不接收明文、写入凭据文件或新增加密算法。凭据状态仅由传输描述符 `credentials.configured` 读取。用户完成独立窗口后点击 GUI 刷新。
- 凭据配置/清除仍由现有安全控制台交互完成，这一公共协议边界不适合在 GUI 专属分支上绕过或替换；原生纯 WPF 密码输入属于日后明确批准公共协议扩展后再考虑的事项。

## 首次使用引导

- 运行设置新增“打开配置向导”，默认不弹出，不干扰并行使用桌面。六步：环境检测、14/21 工具模式、Restricted/Full 及根目录、传输适用性、配置汇总、保存与连接检查。
- 向导数据只保留于该窗口内，切换和取消不产生服务副作用。完成时返回当前 GUI 原有 `Save` 流程，保留 Revision、防陈旧、逐项管理 API 校验、最终操作确认及可选启动。后续使用既有 MCP 检测/连接页展示状态；远程调用仍须独立验证。
- 已有配置的实例随时可重新打开向导；不增加托盘、开机自启、日志数据库、通用凭据服务或公共管理协议变更。

## 验证

- `tests/gui-contract`：B3 和 B4 视图模型、日志有界缓存/筛选/脱敏、代理规范化与 local-dev 能力限制。
- `tests/gui-b4-hosted.mjs`：全新隔离临时托管夹具（独立 LOCALAPPDATA），真实共享 CLI 网络 CAS/有效与无效代理/确认/自动恢复/日志脱敏/凭据不可交互边界，不涉及正式实例。
- `tests/gui-b4-security.mjs`：GUI 源码安全边界审查及合成 DPAPI 往返，无真实密钥。
- `tests/gui-visual`：真实 WPF 离屏五页、日志筛选、六步向导、深浅主题、100%/125%/150% 和本地实例代理权限门禁。
- `tests/gui-e2e` 和 `--partial-recovery`：实际隔离实例管理操作与恢复；`tests/gui-b3-modes.mjs`：真实 14/21 两种 MCP 模式及还原。正式主线、Gemini 工作区仅做保护性只读核对。
- Release win-x64 包必须包含 B4 GUI 执行代码、B3 diagnostics 及更新后的 README，解包真实启动并与引擎生命周期独立；本地 `test-runtime` 保留证据，不公开实例日志或密钥。
