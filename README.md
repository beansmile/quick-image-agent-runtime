# Quick Image Agent Runtime

Quick Image Agent Runtime 是 Quick Image Agent Plugin 使用的本地处理运行时。它负责在用户设备上检查和预处理会话附件、执行确定性估价，将暂存附件上传到 Quick Image 服务签发的目标，并把任务结果的预览媒体受约束地下载到私有缓存目录供宿主以本地文件投递（仅 HTTPS、拒绝重定向、超时与大小上限、magic bytes 校验；缓存仅按容量阈值从旧到新淘汰）。

同一个包也导出本地处理核心 API 和 `quick-image-local-mcp` stdio 入口。Codex、WorkBuddy、OpenClaw 等 MCP 宿主统一启动 `quick-image-local-mcp`，复用完全相同的媒体处理、估价和上传实现；OpenClaw 原生适配器额外导入核心 API 的预览下载服务，用于向聊天渠道投递生成结果。

本仓库不处理登录、素材归属、最终计价、扣费或任务状态；这些权威业务逻辑保留在 Quick Image 服务端。

## 宿主配置

宿主插件应固定引用经过验证的 GitHub Release tgz：

```json
{
  "quick-image-local": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "--yes",
      "--prefer-online",
      "--package",
      "https://github.com/beansmile/quick-image-agent-runtime/releases/download/v<version>/quick-image-agent-runtime.tgz",
      "quick-image-local-mcp"
    ]
  }
}
```

首次启动需要联网安装运行时依赖。WSL2 是 Windows 的主要兼容目标；原生 Windows 也会尝试运行，但不承诺所有媒体依赖和宿主组合都兼容。`sharp` 会按当前操作系统和 CPU 架构安装对应的原生包，不会下载所有平台的二进制。

## 环境切换 CLI

Runtime 包同时提供 `quick-image` 命令，供维护者显式覆盖 Codex、WorkBuddy 或 OpenClaw 当前使用的远程 MCP 和前端地址。地址由命令调用者传入，不保存在 Runtime 源码或发布产物中。`--host` 支持 `codex`、`openclaw`、`workbuddy`，需逐个宿主执行：

```bash
npx --yes --prefer-online \
  --package quick-image-agent-runtime@latest \
  quick-image env set \
  --host <host> \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
```

查看当前配置或恢复正式默认配置时，使用同一个命令：

```bash
quick-image env status --host <codex|openclaw|workbuddy>
quick-image env reset --host <codex|openclaw|workbuddy>
```

完整执行时，上述两条命令同样需要加上 `npx --yes --prefer-online --package quick-image-agent-runtime@latest` 前缀。命令只改写 quick-image 自身的 MCP 配置：写入前自动备份、写入后校验、失败自动恢复，不影响宿主的其他配置。切换地址不会迁移 OAuth 凭据，完成后需重新授权 quick-image MCP：Codex 执行 `codex mcp login quick-image` 并新建任务加载配置；WorkBuddy 完全退出并重新打开后重新授权；OpenClaw 执行 `openclaw mcp login quick-image`，配置即时生效。WorkBuddy 主目录不在默认位置时可用 `WORKBUDDY_HOME` 环境变量指定；同版本号重装 WorkBuddy 插件不会还原配置，恢复正式环境需执行 `env reset`。Codex 插件更新或重装会把清单还原为插件默认的正式地址，需要时重新执行 `env set`。

## 本地开发

要求 Node.js 20 或更高版本以及 pnpm 10：

```bash
pnpm install
pnpm check
```

`dist/` 是 Release tgz 所需的本地生成产物，不加入 Git。`pnpm check` 会从源码重新构建并校验最终打包文件；构建不生成 source map。

## 发布

1. 修改 `package.json` 中的版本。
2. 执行 `pnpm check`。
3. 提交源码、测试和发布配置，不提交 `dist/`。
4. 创建并推送匹配的 tag，例如稳定版 `v0.2.0` 或预发布版 `v0.2.0-rc.1`。

GitHub Actions 会验证 tag 与包版本一致，从源码重新构建 Runtime，并以固定资产名 `quick-image-agent-runtime.tgz` 连同 SHA-256 摘要上传到 GitHub Release；带预发布后缀的 tag 会标记为 Prerelease。Quick Image Agent Plugin 的 MCP 清单和 OpenClaw 依赖都通过 tag 固定引用所选版本的 Release tgz。
