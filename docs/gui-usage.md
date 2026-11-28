# Local Desktop Commander GUI（M7-B 首版）

## 启动

在 Windows 11 上，在项目根目录运行 `scripts\publish-gui.ps1` 构建自包含 win-x64 GUI。构建完成后双击 `scripts\start-gui.bat`。无需额外安装 .NET 运行时。GUI 与管理 CLI 使用当前 Windows 登录用户权限，不以管理员身份自动提升。

独立目录运行：`LocalDC.Gui.exe --root "D:\path\to\LocalDC"`。该目录必须包含 `management\LDC-CLI.ps1` 及对应版本和运行文件。界面仅管理明确指定的工作区实例。

## 概览与设置

“概览”展示真实引擎运行状态、版本、工具模式、文件访问权限和受限授权根；实际与目标配置独立显示。服务启动、停止、重启都要求确认。运行中状态与 MCP 就绪状态不是同一概念：以本地就绪字段核实健康状况。

“设置”选择文件模式（14 项）或完整终端模式（21 项），切换 Restricted/Full 文件权限和指定授权目录。终端命令始终使用 Windows 用户权限，文件根限制不适用于终端。Full 只在支持的托管实例开放，本地开发代理禁用。保存变更时先停止、写入目标配置；“保存并启动”接着启动实例。配置 revision 与其他管理端冲突时需要重新读取，绝不盲目重试。

关闭 GUI 不会停止 MCP 引擎；TUI、GUI 和 CLI 使用同一套管理核心，可以交替操作。GUI 每三秒读取一次实际状态。需要重置未保存的编辑内容时点击“读取当前配置”。

## 验证与范围

运行 `dotnet run --project tests\gui-contract -- "项目根目录"` 可验证客户端协议。运行 `node tests\gui-mcp-probe.mjs files` 仅在本地开发代理已启动时执行真实 MCP 工具调用。完整终端模式也须在已授权的隔离实例上运行。自动化回归证据保存在本地 test-runtime，正式服务不可当作测试夹具。

M7-B0～B2 仅覆盖核心 GUI 管理功能；连接诊断、日志、凭据、升级和扩展属于后续 B3～B7。
