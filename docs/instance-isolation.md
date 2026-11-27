# Windows 运行实例

一个实例对应一个实际工作区或部署目录。管理器以工作区绝对路径和实例名生成实例键。在同一个目录内，从任何当前目录启动该目录的 BAT、TUI 或 JSON CLI，都会使用同一实例键和管理锁。每次 JSON 请求使用自己的子进程和 stdio 管道，无共享监听地址。GUI 应启动目标工作区内的 CLI，并在首个状态请求后保存 `state.instance.key`，随请求发送 `instance`。键不匹配返回 `INSTANCE_MISMATCH`。

| 环境 | 管理入口 | 传输与授权 |
| --- | --- | --- |
| 当前正式 v1.0.0 | 正式部署目录原有入口 | 原 OpenAI 隧道、原 DPAPI 存储及原授权目录。 |
| GUI | GUI 工作区的 BAT 与 JSON CLI | 实例名 `gui`，官方工具的本地开发代理，仅绑定回环地址。文件根限制在本工作区的 `engine/workspace`。 |
| Gemini | Gemini 工作区的 BAT 与 JSON CLI | 实例名 `gemini`，同样使用独立本地代理和文件根。 |

未来从此源码新部署托管实例时，使用相应目录的 OpenAI 运行配置，并通过菜单 12 为该部署保存密钥。新存储位于当前用户 `LOCALAPPDATA/LocalDC-Instances/<实例键>`，没有从旧版存储自动导入。开发代理不调用 OpenAI 控制平面，不读取其密钥，并去除传给本地代理的继承密钥变量。旧版托管锁保留用于托管启动，开发实例使用各自的管理锁。

## 开发操作

从相应 Git Worktree 运行 `scripts/init-dev-instance.ps1 -Id gui` 或 `-Id gemini`。工作区须已具备固定版本的 tunnel-client、依赖及构建产物。初始化生成本地实例标记、版本登记、本地代理配置和文件授权范围。此后使用工作区根目录的启动及停止 BAT、管理菜单，或者 `scripts/status-instance.bat` 查看状态。

- `management/instance.local.json` 绑定该工作区的实例身份。
- `management/runtime` 保存选择、任务、事件和临时文件。启动进程及其子进程使用本区 TEMP 和 TMP。
- `engine/proxy.local.json` 设置本地会话时限，默认四小时。启动时由操作系统为 MCP 入口和健康检查分别分配回环端口。
- `engine/runtime` 保存 PID、健康地址、日志及 `proxy-url.json`。此文件供同机测试客户端读取。
- `engine/allowed-root.txt` 只能指向当前实例的工作目录或其子目录。完整终端模式具有当前 Windows 用户权限。
- 启停会校验本实例的可执行文件路径、命令行、PID 记录和进程创建时间。健康观测还校验监听者 PID。

两个工作区都停止后，可从任一工作区运行 `scripts/test-instance.bat`。测试实际启动两个代理、调用 MCP、分开停止服务并恢复测试前的授权配置。也可给测试命令传入两个工作区路径，顺序为 GUI、Gemini。

## 公共代码的变更

GUI 与 Gemini 分支各自维护专属功能。协议、核心引擎和共享管理逻辑从 `develop` 建独立公共维护分支，完成契约及回归后合入 `develop`，再将同一个公共提交同步至两条开发线。两线共用同一协议版本和契约测试。

每个部署的文件权限配置独立。本地开发代理仍保持工作区限制。参见 [文件访问权限](file-access.md)。
