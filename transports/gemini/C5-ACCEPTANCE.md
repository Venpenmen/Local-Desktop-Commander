# M7-C5 验收跟踪与严格完成标准

本表不预填 PASS。真实本地测试可标记 LOCAL VERIFIED；需要外部 ngrok/Gemini 端真实确认的列项必须在收到证据后才能标记 WEB VERIFIED。

| 阶段 | 本地已具备能力 | 正式验收所需结果 |
|---|---|---|
| C5.0 工程基线 | Gemini 分支及 C2/C4 断点独立、正式服务只读健康 | 核对 Git SHA、三个工作区和健康 |
| C5.1 固定免费网站 | 官方免费静态开发域名方案与 Authenticode ngrok 3.39.13 准备 | 用户账户分配真实域名，实际 ngrok 连接、HTTPS OAuth 元数据和重启后地址不变 |
| C5.2 OAuth 集成 | PKCE S256、Google callback、官方元数据、MCP 代理与 DPAPI | 正式 Gemini 网页 OAuth 登录与真实工具回执 |
| C5.3 凭据持久化 | DPAPI 用户绑定加密注册/refresh、撤销、非法密文拒绝 | 正式公网断线/重启后 Gemini 授权可复用 |
| C5.4 OAuth 与权限 | 4组 OAuth 本地模式、本机增权确认、旧 grant 全部作废 | 网页 Full/terminal 授权升级后的真实权限限制 |
| C5.5 独立管理入口 | `Start-Gemini.cmd`，CLI、隐藏 authtoken、状态与撤销 | 用户可正常配置并启动自身 ngrok 免费账号 |
| C5.6 稳定性 | 回环重启/故障及模拟 ngrok 退避；仅自有进程清理 | 真实公网中断、令牌到期与计算机重启/恢复 |
| C5.7 自动化预验收 | 本地 C2/C4/C5 回归、四模式、21工具、OAuth/HTTP/DPAPI/隔离 | 自动化最终退出码全部 PASS |
| C5.8 Gemini 官方网页版 | C2 read_file 曾真实验证 | C5 正式 OAuth 应用、原生全部能力、四权限与真实重连 L5 |
| C5.9 工程收尾 | 文档、证据、分支提交/远端核验 | 人工验收后同步最终记录及交接 C6 |

## 公网安全约束

- 不允许把 C4 原生回环 Bearer 直接公布，也不允许明文密钥写入源文件、日志或聊天。
- 免费 ngrok 地址和 authtoken 由用户在自己的账户获取；公开域名可回传，authtoken 必须在 Windows 控制台隐藏输入。
- 只使用官方签名通过的客户端，禁用请求检查器、限制回环监听，遵守免费流量及请求额度。
- OAuth 的 access/refresh grant 绑定实例、issuer 和配置修订号；扩大工具或根目录前必须作废旧授权。
- C5 无权限改动正式 main/v1.0.0、Core develop 或 GUI 支线。
- 固定上游 Local DC 配置禁止 Markdown→PDF 创建；保留 PDF 现有页面编辑，不绕过。

## 真实网页人工验收的推荐顺序

1. 免费固定域名与 HTTPS 元数据、匿名调用拒绝；
2. 首次 OAuth client 注册/关联、Google 精确回调、一人一次本地确认；
3. Restricted 文件读取、目录操作和越界拒绝；
4. 增加终端工具：重新 OAuth 授权、Windows 用户权限说明和真实 harmless 命令；
5. Full 模式重新 OAuth 授权，并仅访问受控测试路径；
6. 断网/隧道重新启动后旧连接恢复、access refresh；
7. 撤销授权后旧 token 401，重新授权可用；全部日志及正式服务状态核对。

执行记录仅以实际工具日志、自动化结果和 Gemini 官方网页回执为准。
