import { chmod, lstat, mkdir } from "node:fs/promises";
import { PluginError } from "../errors.js";

export interface PrivateDirectoryPolicy {
  code: string;
  message: string;
  suggestedAction: string;
}

/**
 * 确保目录存在且仅当前用户可访问：必须是真实目录（符号链接视为不安全），
 * 组/其他权限位越界时收敛为 0700。安全判定失败抛 `policy` 指定的
 * PluginError；本地 fs 故障抛原始错误，由调用方按各自的错误分类收敛。
 */
export async function ensurePrivateDirectory(
  directory: string,
  policy: PrivateDirectoryPolicy
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PluginError(policy.code, policy.message, {
      suggested_action: policy.suggestedAction
    });
  }
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
}
