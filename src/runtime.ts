import os from "node:os";
import path from "node:path";
import { PluginError } from "./errors.js";

export function assertSupportedRuntime(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 20) {
    throw new PluginError("NODE_VERSION_UNSUPPORTED", "Quick Image 本地附件处理核心需要 Node.js 20 或更高版本。", {
      current_value: process.versions.node,
      limit_value: ">=20",
      suggested_action: "升级 Node.js 后重新启动宿主。"
    });
  }

  if (process.platform === "win32") {
    throw new PluginError("NATIVE_WINDOWS_UNSUPPORTED", "Quick Image P0 不支持原生 Windows。", {
      suggested_action: "请在 Windows WSL2 中安装并运行插件。"
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
