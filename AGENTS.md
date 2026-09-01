# quick-image-agent-runtime 仓库协作规则

- 本仓库是公开的本地 Agent 运行时。不得写入真实凭据、用户附件、内部地址、私有仓库实现或服务端安全细节。
- 本地代码只负责附件检查、媒体预处理、确定性估价、私有暂存和受约束直传。鉴权、归属、最终计价、扣费、幂等和任务状态必须由服务端强制执行。
- `dist/` 是由 CI 和本地构建生成的发布产物，不加入 Git；禁止生成或发布 source map。
- 发布前必须执行 `pnpm check`，从源码重新构建并检查产物、npm pack 文件清单和敏感信息。
- Commit 使用 Conventional Commits，scope 相对于本仓库，描述使用中文。
