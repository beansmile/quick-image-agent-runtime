# quick-image-agent-runtime 仓库协作规则

- 本仓库是公开的本地 Agent 运行时。不得写入真实凭据、用户附件、内部地址、私有仓库实现或服务端安全细节。
- 本地代码只负责附件检查、媒体预处理、确定性估价、私有暂存和受约束直传。鉴权、归属、最终计价、扣费、幂等和任务状态必须由服务端强制执行。
- `dist/` 是生成 GitHub Release tgz 所需的正式产物，必须与源码一起审查和提交；禁止生成或提交 source map。
- 发布前必须执行 `pnpm check`，检查源码、构建产物和 npm pack 文件清单，并扫描敏感信息。
- Commit 使用 Conventional Commits，scope 相对于本仓库，描述使用中文。
