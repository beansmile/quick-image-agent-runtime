# Quick Image Agent Runtime

Quick Image Agent Runtime 是 Quick Image Agent Plugin 使用的本地处理运行时。它负责在用户设备上检查和预处理会话附件、执行确定性估价，并将暂存附件上传到 Quick Image 服务签发的目标。

同一个包也导出本地处理核心 API。Codex 等 MCP 宿主启动 `quick-image-local-mcp`，OpenClaw 原生适配器直接导入核心 API，从而复用完全相同的媒体处理、估价和上传实现。

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
      "--package",
      "https://github.com/beansmile/quick-image-agent-runtime/releases/download/v0.2.0/quick-image-agent-runtime-0.2.0.tgz",
      "quick-image-local-mcp"
    ]
  }
}
```

首次启动需要联网安装运行时依赖。`sharp` 会按当前操作系统和 CPU 架构安装对应的原生包，不会下载所有平台的二进制。

## 环境切换 CLI

Runtime Release tgz 同时提供 `quick-image` 命令，供维护者显式覆盖 Codex 或 OpenClaw 当前使用的远程 MCP 和前端地址。地址由命令调用者传入，不保存在 Runtime 源码或发布产物中：

```bash
npx --yes \
  --package https://github.com/beansmile/quick-image-agent-runtime/releases/download/v<version>/quick-image-agent-runtime-<version>.tgz \
  quick-image env set \
  --host codex \
  --server-url https://<server>/mcp \
  --frontend-url https://<frontend>
```

查看当前配置或恢复正式默认配置时，使用同一个 Runtime Release tgz：

```bash
quick-image env status --host <codex|openclaw|all>
quick-image env reset --host <codex|openclaw|all>
```

完整执行时，上述两条命令同样需要加上 `npx --yes --package <Runtime Release tgz>` 前缀。Codex 会通过 `codex plugin list --json` 自动定位 Quick Image Plugin 的 Marketplace 工作副本，并根据返回的 Marketplace、Plugin 与版本信息定位 `plugins/cache` 中的实际安装缓存；两处的 Codex MCP 清单和 `mcp.json` 会同步更新，只修改 `quick-image` 服务并保留其他服务，任一写入失败都会回滚。OpenClaw 通过宿主的 `mcp set` 和 Gateway 重启生效。切换地址不会读取、迁移或复用 OAuth 凭据，完成后必须按命令输出重新登录对应的 `quick-image` MCP。Codex 还需要新建任务加载新配置。

同一个 Runtime Release tgz 还提供安装诊断命令：

```bash
npx --yes \
  --package https://github.com/beansmile/quick-image-agent-runtime/releases/download/v<version>/quick-image-agent-runtime-<version>.tgz \
  quick-image-doctor --host <codex|openclaw>
```

Doctor 检查运行平台、媒体依赖、私有状态目录和上传策略；OpenClaw 还会检查 Quick Image 原生工具是否被当前工具策略允许。诊断只返回脱敏状态，不修改宿主配置，也不读取 OAuth 凭据。

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

GitHub Actions 会验证 tag 与包版本一致，从源码重新构建 Runtime，并将 tgz 和 SHA-256 摘要上传到 GitHub Release；带预发布后缀的 tag 会标记为 Prerelease。Quick Image Agent Plugin 的 MCP 清单和 OpenClaw 依赖都固定引用所选版本的 Release tgz。
