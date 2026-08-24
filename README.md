# Quick Image Agent Runtime

Quick Image Agent Runtime 是 Quick Image Agent Plugin 使用的本地处理运行时。它负责在用户设备上检查和预处理会话附件、执行确定性估价，并将暂存附件上传到 Quick Image 服务签发的目标。

同一个包也导出本地处理核心 API。Codex 等 MCP 宿主启动 `quick-image-local-mcp`，OpenClaw 原生适配器直接导入核心 API，从而复用完全相同的媒体处理、估价和上传实现。

本仓库不处理登录、素材归属、最终计价、扣费或任务状态；这些权威业务逻辑保留在 Quick Image 服务端。

## 宿主配置

宿主插件应固定引用经过验证的 tag：

```json
{
  "quick-image-local": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "--yes",
      "--package",
      "git+https://github.com/beansmile/quick-image-agent-runtime.git#v0.1.0",
      "quick-image-local-mcp"
    ]
  }
}
```

首次启动需要联网安装运行时依赖。`sharp` 会按当前操作系统和 CPU 架构安装对应的原生包，不会下载所有平台的二进制。

## 本地开发

要求 Node.js 20 或更高版本以及 pnpm 10：

```bash
pnpm install
pnpm check
```

`dist/` 是 Git tag 安装所需的正式运行产物。修改源码后必须重新执行 `pnpm build` 并提交对应产物；构建不生成 source map。

## 发布

1. 修改 `package.json` 中的版本。
2. 执行 `pnpm check`。
3. 提交源码和 `dist/`。
4. 创建并推送匹配的 tag，例如 `v0.1.0`。

GitHub Actions 会验证 tag 与包版本一致，并将 tgz 和 SHA-256 摘要上传到 GitHub Release。Quick Image Agent Plugin 仍通过 Git tag 安装运行时；Release tgz 用于审计和独立验证。
