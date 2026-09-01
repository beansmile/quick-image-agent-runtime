export const QUICK_IMAGE_MCP_NAME = "quick-image";
export const QUICK_IMAGE_PRODUCTION_SERVER_URL = "https://quickimage.ai/mcp";
export const QUICK_IMAGE_PRODUCTION_FRONTEND_URL = "https://quickimage.ai";
export const QUICK_IMAGE_FRONTEND_HEADER = "X-Quick-Image-Frontend-URL";
export const QUICK_IMAGE_VERSION_HEADER = "X-Quick-Image-Plugin-Version";
export const QUICK_IMAGE_OAUTH_SCOPE = "presets:read assets:write tasks:read tasks:write";

export interface EnvironmentUrls {
  serverUrl: string;
  frontendUrl: string;
}

export interface EnvironmentStatus {
  host: "codex" | "openclaw";
  configured: boolean;
  source: "plugin-default" | "custom" | "production-default" | "external" | "missing";
  serverUrl?: string;
  frontendUrl?: string;
  authenticationCommand?: string;
}

export interface OpenClawMcpConfig {
  transport: "streamable-http";
  url: string;
  auth: "oauth";
  oauth: { scope: string };
  headers: Record<string, string>;
}

export function normalizeEnvironmentUrls(serverUrl: unknown, frontendUrl: unknown): EnvironmentUrls {
  return {
    serverUrl: validateServerUrl(serverUrl),
    frontendUrl: validateFrontendUrl(frontendUrl)
  };
}

export function productionEnvironmentUrls(): EnvironmentUrls {
  return {
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  };
}

export function buildOpenClawMcpConfig(
  urls: EnvironmentUrls,
  runtimeVersion: string
): OpenClawMcpConfig {
  return {
    transport: "streamable-http",
    url: urls.serverUrl,
    auth: "oauth",
    oauth: { scope: QUICK_IMAGE_OAUTH_SCOPE },
    headers: {
      [QUICK_IMAGE_VERSION_HEADER]: runtimeVersion,
      [QUICK_IMAGE_FRONTEND_HEADER]: urls.frontendUrl
    }
  };
}

export function validateServerUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--server-url 缺少 URL");
  const url = parseUrl(value, "MCP URL");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL 不得包含凭据、查询参数或片段");
  }
  if (url.pathname !== "/mcp") throw new Error("MCP URL 路径必须是 /mcp");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MCP URL 必须使用 HTTPS；仅 loopback 本地调试允许 HTTP");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateFrontendUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("--frontend-url 缺少 URL");
  const url = parseUrl(value, "前端 URL");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("前端 URL 不得包含凭据、查询参数或片段");
  }
  if (url.pathname !== "/") throw new Error("前端 URL 只能配置 origin，不得包含路径");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("前端 URL 必须使用 HTTPS；仅 loopback 本地调试允许 HTTP");
  }
  return url.origin;
}

function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} 无效`);
  }
}
