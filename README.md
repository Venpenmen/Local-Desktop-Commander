# Local Desktop Commander v1.0.0

**English** · [简体中文](README.zh-CN.md)

Local Windows file and terminal tools for MCP clients. LDC adapts Desktop Commander MCP v0.3.4, uses OpenAI Secure MCP Tunnel for ChatGPT, and keeps a standard stdio entry point.

Use Windows 11 x64, PowerShell 5.1 and Node.js 24.17.0 (tested baseline). Check the ZIP against SHA256SUMS.txt before extracting it. Install Node.js separately. Run scripts/configure.ps1 with an authorized local folder and an existing Tunnel ID. Open LDC管理入口.bat, use menu 12 to save the existing runtime key, optionally configure a proxy in 11, and start in 1.

File mode defaults to 14 tools. Terminal mode adds seven tools and commands run as your Windows user. The file-tool directory limit does not sandbox commands. Windows DPAPI protects the saved key for the current user. Local clients can run node engine/stdio.mjs, with --terminal only when explicitly intended.

Build with scripts/install.ps1, scripts/build.ps1 and scripts/deploy.ps1. See [installation](docs/installation.md), [configuration](docs/configuration.md), [tools](docs/tools.md), [troubleshooting](docs/troubleshooting.md) and [security](SECURITY.md). LDC original code is MIT-licensed, copyright 2026 Venpenmen. Upstream and third-party notices are retained. See [third-party notices](THIRD_PARTY_NOTICES.md). v1.0.x focuses on stability. Gemini and Antigravity are future work.
[ChatGPT / 管理](docs/management.md) · [Migration / 迁移](docs/migration.md)
ZIP: first run scripts/install-runtime.ps1 to install locked production dependencies. / ZIP 解压后先运行 scripts/install-runtime.ps1 安装锁定的生产依赖。


## Local management API

See [management API v1](docs/management-api.md) for the JSON CLI, and [transport contracts](docs/transport-extensions.md) for adapter development.
