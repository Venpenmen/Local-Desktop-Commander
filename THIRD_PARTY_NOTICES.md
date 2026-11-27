# 第三方

- Desktop Commander MCP v0.3.4 / 9a101b17e44577f0baefa4c7120f087881c5cc56，MIT，原文 engine/upstream/LICENSE。P6 补丁在 engine/patches。
- OpenAI tunnel-client v0.0.21，Apache-2.0，见 transports/openai/LICENSE、NOTICE、依赖许可报告。安装从官方归档校验 SHA256。
- @vscode/ripgrep-win32-x64 1.18.0，许可证 engine/ripgrep-LICENSE；部署核对二进制 SHA256。
- npm 依赖由 engine/upstream/package-lock.json 固定，保留安装包各自许可。再分发前复核完整许可清单。
Windows 包不含 Node.js，用户单独安装。Tunnel 官方归档中的 LICENSE、NOTICE、SPDX 及依赖声明随组件保留；ripgrep 使用 npm 固定版本及原包许可。生产依赖保留各自许可，原创 LDC 许可独立待确认。
公开 ZIP 不捆绑 npm 生产依赖，用户通过锁文件安装。这样避免直接再分发 @img/sharp-win32-x64 的 LGPL 组件；本地安装仍应保留其随附许可。
