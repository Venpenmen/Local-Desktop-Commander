# M7-B0～B2 GUI 技术设计与验收边界

## 目标和交互

Windows 11 桌面管理界面，替代频繁打开 TUI 的常见操作。当前阶段含“概览”和“设置”两个侧边标签；概览展示服务实际状态、实际/目标版本、模式、文件授权根、就绪、最近任务；设置负责 14 项文件工具与 21 项完整终端工具切换、文件访问 Restricted/Full、授权根目录及保存/启动。

## 架构冻结

- **框架**：WPF / .NET 10，Windows x64 自包含发行；主窗体 XAML，GuiState 负责 INotifyPropertyChanged 和视图数据绑定，MainWindow 为用户操作协调器，ManagementClient 为管理协议客户端。
- **服务管理**：复用 `management/LDC-CLI.ps1`。每次操作创建一次独立 Windows PowerShell 5.1 子进程，标准输入输出一行 UTF-8 JSON，确保服务与 GUI 生命周期分离。禁止在 GUI 中复制、绕开或修改引擎管理逻辑。
- **实例固定**：第一次 `state` 取得完整 instance.key，后续请求将实例键回传，任何键不匹配直接拒绝。GUI 从当前部署的祖先管理目录自动定位；自包含包使用显式 `--root` 参数，不能静默管理另一部署。
- **异步与并发**：所有管理调用异步等待，独立读取 stderr 和 stdout；超时（默认 90 秒）标记“结果未知”，重新读取状态后由用户决定下一步，不自动重试修改。客户端 SemaphoreSlim 协调刷新与操作，忙时禁用操作；每 3 秒从状态快照更新 UI。
- **状态**：actual 由真实观察生成、target 由持久化配置读取，互不覆盖；fileAccess.actual 从当前引擎运行证据独立提供，缺失显示未知；readiness.local 与运行中状态分开。GUI 随时可关闭，关闭不会触发服务停止。
- **配置编辑**：表单绑定完整 revision。保存时先重新读取并比较 revision；工具模式和授权根发生变化时，运行中实例须先停止；每次已完成写入后重新读取 revision，再进行下一次配置操作。更新失败会重新载入真实配置，以免出现部分成功被误当成全部成功。
- **权限**：文件工具的受限目录保存于配置；Full 仅受支持的托管实例开放，本地开发代理始终拒绝。终端工具始终使用当前 Windows 用户权限，不属于文件根沙箱。所有变更需确认，后端仍执行 revision、实例及授权检查。
- **错误处理**：管理接口结构化错误码直接展示（如 `REVISION_CONFLICT`、`INVALID_ROOT`、`ACCESS_BUSY` 和 `ACCESS_UNAVAILABLE`），刷新与更改不交叉覆盖。只有当前确实读取到状态时才允许可变更操作。

## 验收分层

1. **协议**：tests/gui-contract 验证 UTF-8 请求、身份绑定、config、capabilities、versions、错误、超时及失效状态恢复。
2. **管理与权限**：沿用 tests/m7-management、m7-access、m7-access-managed、m7-isolation，保证公共行为和受管 Full 权限矩阵。
3. **实际工具**：tests/gui-mcp-probe 在独立本地代理上以 streamable HTTP 实际发现 14/21 工具、调用文件工具、拒绝目录越界和执行真实终端命令。
4. **运行联动**：test-runtime/gui-b2-background.ps1 在 GUI 实例上检测状态、配置生效、revision、并发、重启、还原原配置；原始数据和实际结果存储在 test-runtime。
5. **WPF 实机控件**：tests/gui-e2e 使用离屏 WPF 主窗体并直接触发真实按钮处理器；确认服务由测试程序代替弹窗，避免影响用户桌面；测试启动、停止、保存并启动、重启、TUI 同步、关闭与重开、部分写入失败恢复。
6. **视觉与异常**：tests/gui-visual 生成概览/设置、150% 缩放和最小窗口的 WPF 渲染截图，测试轮询、手动刷新、非法根；独立离屏宿主强制退出验证 MCP 引擎不被带走。
7. **构建**：scripts/publish-gui.ps1 发布自包含 Windows x64 可执行程序；scripts/start-gui.bat 为项目内启动入口；保留原 scripts/status-instance.bat 和管理 TUI。

## 保护与后续

测试实例 `gui/local-dev` 与 Gemini、正式服务各自隔离；只对 GUI 实例执行受控启停，原则上测试后恢复开始时的配置和运行状态。测试夹具复制公共管理代码时排除 `instance.local.json`，避免预期托管实例被误判为开发代理。STATE.md/TASKS.md 是独立本地断点，详细实测证据保留于忽略的 test-runtime 目录。

B0–B2 完成后，B3 连接诊断与异常恢复、B4 日志/凭据/首次使用、B5 升级与回滚、B6 扩展及多客户端、B7 集成发行与 TUI 退役评估仍为后续阶段；本次未在正式服务部署 GUI。
