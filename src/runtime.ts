import os from "node:os";
import path from "node:path";
import { PluginError } from "./errors.js";

export function assertSupportedRuntime(platform = process.platform): void {
  // 保留平台参数用于宿主/测试注入；当前平台差异不构成本地运行时的硬阻断。
  void platform;
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 20) {
    throw new PluginError("NODE_VERSION_UNSUPPORTED", "Quick Image 本地附件处理核心需要 Node.js 20 或更高版本。", {
      current_value: process.versions.node,
      limit_value: ">=20",
      suggested_action: "升级 Node.js 后重新启动宿主。"
    });
  }

}

export async function assertRuntimeDependencies(): Promise<void> {
  await Promise.all([import("sharp"), import("mediainfo.js")]);
}

export function resolveDataDirectory(): string {
  const explicit = process.env.QUICK_IMAGE_DATA_DIR?.trim();
  const pluginData = process.env.PLUGIN_DATA?.trim();
  const base = explicit || pluginData;
  if (base) return path.resolve(base, "upload-bridge");

  const xdgState = process.env.XDG_STATE_HOME?.trim();
  if (xdgState) return path.resolve(xdgState, "quick-image-agent-runtime");

  return path.join(os.homedir(), ".local", "state", "quick-image-agent-runtime");
}

export function resolveOpenClawAttachmentRegistryDirectory(): string {
  const explicit = process.env.QUICK_IMAGE_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit, "upload-bridge");

  const xdgState = process.env.XDG_STATE_HOME?.trim();
  if (xdgState) return path.resolve(xdgState, "quick-image-agent-runtime");

  return path.join(os.homedir(), ".local", "state", "quick-image-agent-runtime");
}
