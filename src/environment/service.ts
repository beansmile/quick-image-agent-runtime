import {
  readCodexEnvironmentStatus,
  resetCodexEnvironment,
  setCodexEnvironment
} from "./codex.js";
import type { CommandExecutor } from "./command-executor.js";
import {
  normalizeEnvironmentUrls,
  QUICK_IMAGE_PRODUCTION_FRONTEND_URL,
  QUICK_IMAGE_PRODUCTION_SERVER_URL,
  type EnvironmentStatus
} from "./config.js";
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

export interface HostProductionCheck {
  host: "codex" | "openclaw";
  available: boolean;
  is_production: boolean | null;
  source: EnvironmentStatus["source"] | "unavailable";
}

export interface ProductionEnvironmentReport {
  hosts: HostProductionCheck[];
}

export interface ProductionCheckOptions {
  runtimeVersion: string;
  codexBin?: string;
  openClawBin?: string;
  executor?: CommandExecutor;
}

// 供本地 MCP 工具使用的脱敏环境检查：只回答“是否正式环境”，任何情况下都不返回
// 服务器或前端地址，避免非正式环境地址进入 AI 会话上下文。
export async function checkEnvironmentProduction(options: ProductionCheckOptions): Promise<ProductionEnvironmentReport> {
  const hosts: HostProductionCheck[] = [];
  const attempts: Array<"codex" | "openclaw"> = ["codex", "openclaw"];
  for (const host of attempts) {
    try {
      const status = host === "codex"
        ? await readCodexEnvironmentStatus({
            runtimeVersion: options.runtimeVersion,
            ...(options.codexBin ? { codexBin: options.codexBin } : {}),
            ...(options.executor ? { executor: options.executor } : {})
          })
        : await readOpenClawEnvironmentStatus({
            runtimeVersion: options.runtimeVersion,
            ...(options.openClawBin ? { openClawBin: options.openClawBin } : {}),
            ...(options.executor ? { executor: options.executor } : {})
          });
      hosts.push({
        host,
        available: true,
        is_production: status.configured
          ? status.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
            status.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL
          : null,
        source: status.source
      });
    } catch {
      hosts.push({ host, available: false, is_production: null, source: "unavailable" });
    }
  }
  return { hosts };
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
