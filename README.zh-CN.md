# Local Desktop Commander v1.0.0

[English](README.md) · **简体中文**

为 MCP 客户端提供 Windows 本地文件和终端工具。LDC 适配 Desktop Commander MCP v0.3.4，ChatGPT 通过 OpenAI Secure MCP Tunnel 接入，同时保留标准 stdio。

实测基线为 Windows 11 x64、PowerShell 5.1 和 Node.js 24.17.0。解压前使用 SHA256SUMS.txt 校验 ZIP，Node.js 单独安装。运行 scripts/configure.ps1 输入授权目录和已有 Tunnel ID。打开 LDC管理入口.bat，菜单 12 保存已有运行密钥，按需用 11 设置代理，最后用 1 启动。

默认文件模式 14 项工具。终端模式额外开放 7 项，命令使用当前 Windows 用户权限。文件目录限制仅约束文件工具。密钥使用当前用户 Windows DPAPI 保护。本地客户端可运行 node engine/stdio.mjs，仅在明确授权终端时加 --terminal。

运行 scripts/install.ps1、scripts/build.ps1、scripts/deploy.ps1 构建。见 [安装](docs/installation.md)、[配置](docs/configuration.md)、[工具](docs/tools.md)、[排障](docs/troubleshooting.md) 和 [安全](SECURITY.md)。LDC 原创代码采用 MIT，版权署名 Venpenmen。保留上游及第三方声明。见 [第三方声明](THIRD_PARTY_NOTICES.md)。v1.0.x 优先稳定性，Gemini 与 Antigravity 属于后续工作。
[ChatGPT / 管理](docs/management.md) · [Migration / 迁移](docs/migration.md)
ZIP: first run scripts/install-runtime.ps1 to install locked production dependencies. / ZIP 解压后先运行 scripts/install-runtime.ps1 安装锁定的生产依赖。

