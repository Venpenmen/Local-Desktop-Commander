# C5-U 统一公网隧道架构（Gemini 独立工作区）

## 定位与边界

本阶段在 Gemini 分支内抽象隧道接口，不修改 M7 公共管理 API、GUI、主线或生产部署。公网提供商只将 HTTPS 请求转发到本机回环 OAuth 网关，不直接暴露 C4 原生 Bearer MCP 网关。OAuth（PKCE、Google 精确回调、DPAPI、撤销和权限修订）与传输模块解耦。

## 核心模块

| 文件 | 角色 |
|---|---|
| tunnel-contract.mjs | Provider ID、能力表、固定/动态 HTTPS 发行地址校验、配置版本与状态格式 |
| tunnel-manager.mjs | Provider 工厂、前置检查、统一 start/stop/restart/status/recheck/probe、并发互斥 |
| cloudflare-agent.mjs | Quick Tunnel 受管进程、安全签名校验、动态 trycloudflare 域名解析、在线元数据探测与断线封闭 |
| tunnel-relay.mjs | 动态域名启动前使用回环 503 隔离入口；OAuth 发布后才转发 |
| ngrok-agent.mjs | 保留现有 C5 ngrok Free 静态域名适配，不更改旧签名及重试约束 |
| runner.mjs | 由提供商能力决定固定/动态两条启动路径，管理独立实例、OAuth 生命周期和凭据 |
| cli.mjs / console.mjs | Provider 管理、配置修订检查、显式重授权、独立凭据与状态 |

## Provider 能力与实际范围

| ID | 地址 | 管理模型 | 本轮实现 |
|---|---|---|---|
| ngrok | 固定 *.ngrok-free.dev/.app | 受管进程 | 既有 C5 适配迁移与回归；尚无用户账户公网证据 |
| cloudflare-quick | 每次启动发现 *.trycloudflare.com | 受管进程 | 两阶段启动、自动域名解析、真实回环+mock Agent 验证；尚无新一轮官网 L5 |
| cloudflare-named | 用户持有固定 HTTPS 域名 | 受管进程（预留） | 配置/能力/凭据契约；**尚未实现真实 Named 启动**，调用返回 TUNNEL_PROVIDER_NOT_INSTALLED |
| external-https | 用户持有固定 HTTPS 域名 | 外部管理 | 回环 OAuth 服务、外部元数据探测，无权停止外部网络进程 |

Cloudflare Quick Tunnel 不保证固定域名，也不支持 SSE；仅能将其作为现有 JSON MCP 工具调用的候选，完整 Web 兼容需重新实测。Named 的 Token 模式与部署配置以独立 Cloudflare 研究会话结果为准。

## 配置与凭据

- 每个实例存储 tunnel-config.json：schema=1、provider、issuer（动态为 null）、Named 可选 tunnelId。
- connection.json 记录最近成功发现的 OAuth issuer；动态地址再次变化时清除旧 OAuth DPAPI state 并重新创建发行地址。
- tunnel-secret.dpapi：原 C5 ngrok authtoken，维持旧入口兼容；tunnel-cloudflare-named.dpapi：Named 预留 Token，两者相互独立；oauth-state.dpapi：OAuth 授权。
- 所有敏感凭据都经 Windows 当前用户 DPAPI 存储，不写入公开配置、终端状态或日志。凭据写入/清理必须处于停止状态。
- 旧 C5 只有 connection.json 的实例会按 issuer 推断 ngrok 或 external-https，首次配置后生成 tunnel-config.json；不覆写原有凭据。
- 新 Provider 的配置修订通过 tunnelRevision 计算；CLI 设置要求同修订值、confirmed=true。旧发行地址变更要求 resetAuth=true + riskAcknowledged=true。
- Full/terminal 仍经现有单独人工明确确认，不受公网 Provider 选择影响。

## 启动顺序

固定入口：锁实例 → 创建原生 MCP bridge → 创建回环 OAuth 网关（固定 issuer）→ 启动受管 Agent/外部探针 → 独立返回本地就绪与公网探测结果。

动态 Quick：锁实例 → 创建原生 bridge → 建立仅回环监听且默认 503 的中转 → 启动签名校验通过的 cloudflared → 从进程输出解析合法随机域名 → 清除跨域名的旧 OAuth grant → 基于真实域名创建 OAuth 网关 → 激活本地转发 → 执行公网元数据复核。地址未确认或网关创建失败前不可能产生匿名直达 C4 的通道。

Quick Agent 进程意外退出时禁用回环中转并标为 blocked，不自动为新随机域名沿用旧 OAuth 授权；必须显式重启并重新关联 Gemini。cloudflared 进程内部自身的临时网络重连可继续保持原域名，但需公网 recheck 验证。

## 统一 JS API

- validateTunnelConfig(config) / validatePublicOrigin(url) / tunnelRevision(config)
- createTunnelManager(config, {binary, authtoken, port, runDir, onEvent, onLost})
- manager.capabilities / manager.checkPrerequisites() / manager.status()
- await manager.start() / manager.recheck() / manager.probe() / manager.stop() / manager.restart()
- runner.setTunnelProvider(config,{clearExistingAuthorization})
- runner.setTunnelCredential(provider,secret) / runner.clearTunnelCredential(provider)
- runner.status.connection.tunnelProvider / tunnelCapabilities / tunnelConfigRevision / publicTunnel

checkPrerequisites 是无副作用的存在性与模式检测，**不能替代**启动时的签名或远程公网探测。公网状态 verified 仅表示 OAuth 资源元数据真实返回且资源/授权端地址匹配，不等于 Gemini 网页已完成 OAuth 和工具调用。

## JSON CLI 新增操作（协议 v1 保留）

- tunnel.capabilities：列出全部 Provider 能力和 implementation（local / reserved）。
- tunnel.provider.get：返回实例目标 Provider 配置与 revision。
- tunnel.provider.set：arguments={confirmed:true,revision,config:{schema:1,provider,issuer},resetAuth?:true,riskAcknowledged?:true}。
- tunnel.credential.set：arguments={confirmed:true,provider:'cloudflare-named',secret:'仅本地传入'}。
- tunnel.credential.clear：arguments={confirmed:true,provider:'cloudflare-named'}。
- tunnel.check：启动后实际探测现有公网入口。

既有 ngrok.token.set/clear、connection.set、start/stop/restart、oauth.*、config.* 维持兼容。C6 公共管理 API 需要另立公共维护分支，实现经过授权的实例注册、状态复用与桥接，不在本轮私自修改。

## Windows 客户端

Cloudflare Quick 可执行文件默认在每个独立运行根的 bin/cloudflared.exe。C2 留存的 cloudflared v2026.11.2 已经通过 Windows Authenticode 签名与 SHA256 校验，可放入 Gemini 私有 test-runtime/gemini-personal/bin/；没有安装全局服务或改变网络代理。命令行实际启动前再次核对签名。Named Agent 未部署，也未消费任何域名/付费服务。

## Cloudflare Quick 客户端隔离补充

受管 Quick Tunnel 子进程仅修改自身环境变量 `USERPROFILE` 与 `HOME`，指向 Gemini 实例的私有 tunnel 运行目录，避免误读用户全局 Cloudflare Named Tunnel 的凭据或配置。启动前检查客户端 Authenticode 签名与运行目录的规范化路径；不会修改系统环境变量、Windows 服务或代理设置。网络恢复只保持原进程时可继续使用旧域名，进程退出后禁止绕过新的发行地址授权。
