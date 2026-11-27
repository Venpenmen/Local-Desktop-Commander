# 架构

engine/stdio.mjs 提供标准 MCP，内含独立上游源码和 P6 构建补丁。transports/openai 提供 Tunnel 模板与独立二进制安装目标。engine/LocalDC.ps1 是现有生命周期适配点；management 管理配置、模式和进程。未来新传输可复用 stdio。
