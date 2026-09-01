import {
  readCodexEnvironmentStatus,
  resetCodexEnvironment,
  setCodexEnvironment
} from "./codex.js";
import { normalizeEnvironmentUrls, type EnvironmentStatus } from "./config.js";
import {
  readOpenClawEnvironmentStatus,
  resetOpenClawEnvironment,
  setOpenClawEnvironment
} from "./openclaw.js";

export type EnvironmentHost = "codex" | "openclaw" | "all";
export type EnvironmentAction = "set" | "status" | "reset";

export interface EnvironmentCommandOptions {
  action: EnvironmentAction;
  host: EnvironmentHost;
  runtimeVersion: string;
  serverUrl?: string;
  frontendUrl?: string;
  codexBin?: string;
  openClawBin?: string;
}

export async function executeEnvironmentCommand(options: EnvironmentCommandOptions): Promise<EnvironmentStatus[]> {
  const hosts = options.host === "all" ? ["codex", "openclaw"] as const : [options.host];
  const urls = options.action === "set"
    ? normalizeEnvironmentUrls(options.serverUrl, options.frontendUrl)
    : undefined;
  const results: EnvironmentStatus[] = [];

  for (const host of hosts) {
    if (host === "codex") {
      const codexOptions = {
        runtimeVersion: options.runtimeVersion,
        ...(options.codexBin ? { codexBin: options.codexBin } : {}),
      };
      results.push(options.action === "set"
        ? await setCodexEnvironment(urls!, codexOptions)
        : options.action === "reset"
          ? await resetCodexEnvironment(codexOptions)
          : await readCodexEnvironmentStatus(codexOptions));
      continue;
    }

    const openClawOptions = {
      runtimeVersion: options.runtimeVersion,
      ...(options.openClawBin ? { openClawBin: options.openClawBin } : {})
    };
    results.push(options.action === "set"
      ? await setOpenClawEnvironment(urls!, openClawOptions)
      : options.action === "reset"
        ? await resetOpenClawEnvironment(openClawOptions)
        : await readOpenClawEnvironmentStatus(openClawOptions));
  }
  return results;
}

export function formatEnvironmentResult(action: EnvironmentAction, statuses: EnvironmentStatus[]): string {
  if (action === "status") return `${JSON.stringify({ hosts: statuses }, null, 2)}\n`;

  const verb = action === "set" ? "已更新" : "已恢复正式默认配置";
  const lines = [`Quick Image 环境 URL ${verb}。`];
  for (const status of statuses) {
    lines.push(
      `Host: ${status.host}`,
      `Server: ${status.serverUrl ?? "未配置"}`,
      `Frontend: ${status.frontendUrl ?? "未配置"}`
    );
    if (status.authenticationCommand) lines.push(`重新授权：${status.authenticationCommand}`);
  }
  if (statuses.some((status) => status.host === "codex")) {
    lines.push("Codex 请新建任务以加载最新 MCP 配置。");
  }
  return `${lines.join("\n")}\n`;
}
