# Local DC Gemini · C5 独立版安装与关联

此工作区已有 Windows 本地真实 OAuth 和 14/21 工具适配，不是整套 M7 正式发行版，也不是 ChatGPT 正式服务。C5 与 Gemini 官方网页的完整验收仍需完成。

## 本地首次准备（Windows 11）

1. 运行 `Start-Gemini.cmd`（位于本目录）。它仅调用 Node.js 启动本地交互控制台，不在系统中注册服务。
2. 如果你的免费 ngrok 账户尚未创建，请在 **ngrok 官方网页** `https://dashboard.ngrok.com/signup` 注册 Free 账号，不选择付费升级。
3. 在官方 Dashboard 的 Domains / Assigned Dev Domain 复制免费分配的固定 `https://...ngrok-free.dev` 地址。**域名不是密码，可提供给 ChatGPT 继续调试。**
4. 进入 `https://dashboard.ngrok.com/get-started/your-authtoken` 查找账号 authtoken。**不要发送给 ChatGPT！** 在本地控制台选择 [2]，粘贴到隐藏输入框（显示星号），用当前 Windows 用户 DPAPI 加密保存。
5. 本机控制台选 [1] 粘贴固定域名。默认从 Restricted + 14 工具开始。选 [3] 启动 OAuth + ngrok；选 [0] / [11] 核对本地 MCP 和真实公网 OAuth 元数据。要在网页授权前先确认公网状态是 verified。
6. 在 Gemini 官方网页版的“自定义应用 → 连接到 MCP 服务器”中输入 `https://<分配的域名>/mcp`，记录页面提供的精确 OAuth 回调 URL。回到本机 [4] 注册这个 Google 回调，[6] **仅在本机屏幕显示** Client ID/Client Secret，复制到 Gemini 客户端 OAuth 参数，不要截图或发送给 ChatGPT。
7. 在本机 [5] 创建一次五分钟有效的 OAuth 预授权，然后在 Gemini 官方网页完成连接，按计划进行测试。若超过五分钟，再执行一次 [5]，不必重新生成客户端。
8. 开启 21 工具或 Full 文件权限前，先 [9] 停止，选 [7] 切换，按提示输入 `ENABLE`；再 [3] 启动并重新完成 Google OAuth 授权。**Restricted 仅限制文件工具，不是终端的 Windows 用户沙箱**。
9. 正常关闭可选 [9]、[Q]。重启后的 ngrok 固定域名不应改变，OAuth 客户端及 refresh grant 由 DPAPI 保存；是否能在 Gemini 官方网页无感恢复尚需实际验收。

## 安全、费用与数据边界

- ngrok 免费套餐存在请求/流量额度和可能的浏览器警告，用户应遵守官方免费套餐规则。C5 **不能保证未经真实测试的 Gemini 兼容**。
- ngrok 可执行文件在本工作区忽略目录 `test-runtime/gemini-personal/bin/ngrok.exe`，经官方 Authenticode 签名验证；不修改系统 PATH、网络代理及 Windows 服务。
- OAuth 令牌、ngrok authtoken 都仅保存在实例独立的 Windows DPAPI 凭据文件中，不写入 Git。控制台 [6] 仅限向 Gemini 的 OAuth 设置填写 Client ID/Secret。
- 免费静态公网入口将使工具能力经 OAuth 可被 Gemini 调用，请勿在共享账号/不受信任设备下启用 Full/terminal。
- 如果公开元数据返回的是 ngrok 浏览器警告 HTML 或其他错误，报告实际状态，不绕过付费/浏览器安全限制。
- 本次版本保持 ChatGPT 正式部署、Core 和 GUI 分支不变。

自动化回归执行：`npm.cmd test`。详细验收、后续联调见 `C5-ACCEPTANCE.md` 与 `C5-HANDOFF.md`。
