# Quick Image Agent Runtime

Quick Image Agent Runtime 是 Quick Image Agent Plugin 使用的本地处理运行时。它负责在用户设备上检查和预处理会话附件、执行确定性估价，将暂存附件上传到 Quick Image 服务签发的目标，并把任务结果的预览媒体受约束地下载到私有缓存目录供宿主以本地文件投递（仅 HTTPS、拒绝重定向、超时与大小上限、magic bytes 校验；缓存仅按容量阈值从旧到新淘汰）。

同一个包也导出本地处理核心 API。Codex 等 MCP 宿主启动 `quick-image-local-mcp`，OpenClaw 原生适配器直接导入核心 API，从而复用完全相同的媒体处理、估价、上传和预览下载实现。

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

Runtime Release tgz 同时提供 `quick-image` 命令，供维护者显式覆盖 Codex 或 OpenClaw 当前使用的远程 MCP 和前端地址。地址由命令调用者传入，不保存在 Runtime 源码或发布产物中：

```bash
npx --yes --prefer-online \
  --package https://github.com/beansmile/quick-image-agent-runtime/releases/download/v<version>/quick-image-agent-runtime.tgz \
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

完整执行时，上述两条命令同样需要加上 `npx --yes --prefer-online --package <Runtime Release tgz>` 前缀。Codex 宿主通过 `~/.codex/config.toml` 生效：命令会在文件末尾追加（或替换）带 `# BEGIN/END quick-image managed MCP environment` 标记的 `mcp_servers.quick-image` 管理区块，该区块优先于插件清单中的默认地址，且不受 Codex 重建插件缓存影响。写入前先把原文件备份为同目录的 `config.toml.quick-image-backup`；写入采用临时文件加原子重命名，随后用 `codex mcp list/get` 验证 Codex 能解析并加载新配置，验证失败自动恢复原文。区块外的任何内容不会被改动，接缝处的空行按原样保留（仅删除发生在文件末尾时，尾部空行会收敛为单个换行）。若存在他人手写的同名 `mcp_servers.quick-image` 配置：不带 Quick Image 私有请求头时，命令会拒绝写入并提示先手工处理；同时带有 `X-Quick-Image-Plugin-Version` 与 `X-Quick-Image-Frontend-URL` 两个私有请求头时，会被认定为 Quick Image 写入的配置或标记被破坏的残留，`env set` 将其替换为管理区块、`env reset` 将其清除，被替换的原文均可从备份文件找回。`env reset` 删除该管理区块，Codex 自动回落到插件清单的正式默认地址。OpenClaw 通过宿主的 `mcp set` 和 `mcp reload` 生效。切换地址不会读取、迁移或复用 OAuth 凭据，完成后必须按命令输出重新登录对应的 `quick-image` MCP。Codex 还需要新建任务加载新配置。

本地 MCP 另提供 `check_environment` 工具：检查 Codex 与 OpenClaw 当前生效环境是否为正式环境（production），只返回是否正式、配置来源与宿主是否可检查，不返回任何服务器或前端地址，可安全用于 AI 会话中排查环境问题。

同一个 Runtime Release tgz 还提供安装诊断命令：

```bash
npx --yes --prefer-online \
  --package https://github.com/beansmile/quick-image-agent-runtime/releases/download/v<version>/quick-image-agent-runtime.tgz \
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

GitHub Actions 会验证 tag 与包版本一致，从源码重新构建 Runtime，并以固定资产名 `quick-image-agent-runtime.tgz` 连同 SHA-256 摘要上传到 GitHub Release；带预发布后缀的 tag 会标记为 Prerelease。Quick Image Agent Plugin 的 MCP 清单和 OpenClaw 依赖都通过 tag 固定引用所选版本的 Release tgz。
