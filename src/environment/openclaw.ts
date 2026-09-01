import type { CommandExecutor } from "./command-executor.js";
import { systemCommandExecutor } from "./command-executor.js";
import {
  QUICK_IMAGE_FRONTEND_HEADER,
  QUICK_IMAGE_MCP_NAME,
  QUICK_IMAGE_PRODUCTION_FRONTEND_URL,
  QUICK_IMAGE_PRODUCTION_SERVER_URL,
  type EnvironmentStatus,
  type EnvironmentUrls
} from "./config.js";
import { resolveOpenClawExecutable } from "./executables.js";

interface OpenClawOptions {
  runtimeVersion: string;
  openClawBin?: string;
  executor?: CommandExecutor;
}

export async function setOpenClawEnvironment(
  urls: EnvironmentUrls,
  options: OpenClawOptions
): Promise<EnvironmentStatus> {
  const runtime = openClawRuntime(options);
  const config = readExistingOpenClawConfig(runtime);
  const headers = isObject(config.headers) ? { ...config.headers } : {};
  headers[QUICK_IMAGE_FRONTEND_HEADER] = urls.frontendUrl;
  const updatedConfig = { ...config, url: urls.serverUrl, headers };
  runtime.executor.run(runtime.openClawBin, ["mcp", "set", QUICK_IMAGE_MCP_NAME, JSON.stringify(updatedConfig)]);
  runtime.executor.run(runtime.openClawBin, ["gateway", "restart"]);
  const status = await readOpenClawEnvironmentStatus(options);
  if (!status.configured || status.serverUrl !== urls.serverUrl || status.frontendUrl !== urls.frontendUrl) {
    throw new Error("OpenClaw 未加载刚写入的 Quick Image MCP 配置");
  }
  return status;
}

export async function resetOpenClawEnvironment(options: OpenClawOptions): Promise<EnvironmentStatus> {
  return setOpenClawEnvironment({
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  }, options);
}

export async function readOpenClawEnvironmentStatus(options: OpenClawOptions): Promise<EnvironmentStatus> {
  const runtime = openClawRuntime(options);
  let output: string;
  try {
    output = runtime.executor.run(
      runtime.openClawBin,
      ["config", "get", `mcp.servers.${QUICK_IMAGE_MCP_NAME}`, "--json"]
    ).stdout;
  } catch {
    return { host: "openclaw", configured: false, source: "missing" };
  }
  const urls = parseOpenClawConfig(JSON.parse(output));
  const usesProduction = urls.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
    urls.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
  return {
    host: "openclaw",
    configured: true,
    source: usesProduction ? "production-default" : "custom",
    ...urls,
    authenticationCommand: "openclaw mcp login quick-image"
  };
}

function openClawRuntime(options: OpenClawOptions) {
  return {
    openClawBin: resolveOpenClawExecutable(options.openClawBin),
    executor: options.executor ?? systemCommandExecutor
  };
}

function readExistingOpenClawConfig(runtime: ReturnType<typeof openClawRuntime>): Record<string, unknown> {
  let output: string;
  try {
    output = runtime.executor.run(
      runtime.openClawBin,
      ["config", "get", `mcp.servers.${QUICK_IMAGE_MCP_NAME}`, "--json"]
    ).stdout;
  } catch {
    throw new Error("找不到 OpenClaw Quick Image MCP 配置，请先重新安装 Quick Image Plugin");
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("OpenClaw Quick Image MCP 配置不是有效 JSON，请先重新安装 Quick Image Plugin");
  }
  if (!isObject(value)) {
    throw new Error("OpenClaw Quick Image MCP 配置格式无效，请先重新安装 Quick Image Plugin");
  }
  return value;
}

function parseOpenClawConfig(value: unknown): EnvironmentUrls {
  if (!isObject(value)) throw new Error("OpenClaw MCP 状态输出无效");
  const headers = isObject(value.headers) ? value.headers : {};
  const serverUrl = value.url;
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof serverUrl !== "string" || typeof frontendUrl !== "string") {
    throw new Error("OpenClaw Quick Image MCP 缺少 Server URL 或 Frontend URL");
  }
  return { serverUrl, frontendUrl };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
