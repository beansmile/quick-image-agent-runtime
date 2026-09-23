import { lstat, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QUICK_IMAGE_FRONTEND_HEADER,
  QUICK_IMAGE_MCP_NAME,
  QUICK_IMAGE_PRODUCTION_FRONTEND_URL,
  QUICK_IMAGE_PRODUCTION_SERVER_URL,
  type EnvironmentStatus,
  type EnvironmentUrls
} from "./config.js";
import {
  parseJsonManifestText,
  serializeJsonManifestText,
  stripByteOrderMark,
  writeJsonManifestAtomic
} from "./json-manifest.js";

export { serializeJsonManifestText as serializeWorkBuddyManifestText } from "./json-manifest.js";

// WorkBuddy 没有 env 配置 CLI；它把插件 MCP 清单（插件 manifest 的
// mcpServers 字段指向的文件）从插件安装目录直接加载为 custom-mcp 配置。
// 插件包同时携带 .workbuddy-plugin 与 .codebuddy-plugin 两份 manifest，
// 分别指向 ./.mcp.json 与 ./mcp.json：旧版客户端读前者，新版客户端还会
// 加载后者。因此环境切换收集安装目录内全部候选 manifest 指向的清单并
// 同步改写，只更新 mcpServers.quick-image 的 url 与
// X-Quick-Image-Frontend-URL 两个头，其余配置语义保持不变，并按原文
// 还原 BOM、缩进、行尾与结尾换行；写入前备份，写入后回读校验，失败
// 自动恢复原文，多安装多清单时先整体规划再统一写入。
// 插件缓存以 installed_plugins.json 为权威注册表，孤儿目录（带 .orphaned_at）
// 不会出现在其中，避免误改已废弃的安装。
const WORKBUDDY_MANIFEST_CANDIDATES = [".workbuddy-plugin/plugin.json", ".codebuddy-plugin/plugin.json"] as const;
const WORKBUDDY_REGISTRY_RELATIVE_PATH = path.join("plugins", "installed_plugins.json");
const WORKBUDDY_BACKUP_SUFFIX = ".quick-image-backup";
const HEADER_CONTAINERS = ["headers", "http_headers"] as const;

export interface WorkBuddyOptions {
  workbuddyHome?: string;
}

interface WorkBuddyInstall {
  root: string;
  mcpPaths: string[];
}

interface WorkBuddyMcpUpdatePlan {
  mcpPath: string;
  originalText: string;
  original: Record<string, unknown>;
  updatedText: string;
  mode: number;
}

export async function setWorkBuddyEnvironment(urls: EnvironmentUrls, options: WorkBuddyOptions): Promise<EnvironmentStatus> {
  const installs = await resolveWorkBuddyInstalls(resolveWorkBuddyHome(options.workbuddyHome));
  if (installs.length === 0) {
    throw new Error("在 WorkBuddy 中找不到 quick-image 插件安装，请先在 WorkBuddy 中安装 Quick Image Plugin");
  }
  // 多个安装（不同 scope）先全部完成解析与改写计算，再统一写入：任何一个安装
  // 的任何一份清单无法解析时不会动任何文件；写入阶段中途失败时把已写入的清单
  // 回滚为原文，避免宿主按不同 scope 或不同 manifest 加载到混合环境。
  const plans = [];
  for (const install of installs) {
    for (const mcpPath of install.mcpPaths) {
      plans.push(await planWorkBuddyMcpUpdate(mcpPath, urls));
    }
  }
  const committed: WorkBuddyMcpUpdatePlan[] = [];
  try {
    for (const plan of plans) {
      await commitWorkBuddyMcpUpdate(plan, urls);
      committed.push(plan);
    }
  } catch (error) {
    // 回滚失败时保留各安装的备份文件供人工恢复，原始错误仍然如实上抛。
    for (const plan of committed) {
      await writeJsonManifestAtomic(plan.mcpPath, plan.originalText, plan.mode).catch(() => undefined);
    }
    throw error;
  }
  const status = await readWorkBuddyEnvironmentStatus(options);
  if (!status.configured || status.serverUrl !== urls.serverUrl || status.frontendUrl !== urls.frontendUrl) {
    throw new Error("WorkBuddy 未加载刚写入的 Quick Image MCP 配置");
  }
  return status;
}

export async function resetWorkBuddyEnvironment(options: WorkBuddyOptions): Promise<EnvironmentStatus> {
  return setWorkBuddyEnvironment({
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  }, options);
}

export async function readWorkBuddyEnvironmentStatus(options: WorkBuddyOptions): Promise<EnvironmentStatus> {
  // 注册表或插件清单损坏、布局异常时按未配置上报而不是让 status 整体失败，
  // 与下方对 .mcp.json 损坏的处理一致；set/reset 仍会对这些问题显式报错。
  let installs: WorkBuddyInstall[];
  try {
    installs = await resolveWorkBuddyInstalls(resolveWorkBuddyHome(options.workbuddyHome));
  } catch {
    return { host: "workbuddy", configured: false, source: "missing" };
  }
  // 多个安装（不同 scope）与同一安装的多份清单同时存在时，取第一个可读出
  // quick-image 配置的文件；set/reset 会同步更新全部安装的全部清单，正常
  // 情况下不会出现不一致。
  for (const install of installs) {
    for (const mcpPath of install.mcpPaths) {
      const urls = await readWorkBuddyMcpUrls(mcpPath);
      if (!urls) continue;
      const usesProduction = urls.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
        urls.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
      return {
        host: "workbuddy",
        configured: true,
        source: usesProduction ? "plugin-default" : "custom",
        serverUrl: urls.serverUrl,
        frontendUrl: urls.frontendUrl
      };
    }
  }
  return { host: "workbuddy", configured: false, source: "missing" };
}

export function resolveWorkBuddyHome(explicitPath?: string): string {
  // 显式入参或环境变量为空白时不作为路径使用，避免 resolve("") 落到当前工作目录。
  const configured = explicitPath?.trim() || process.env.WORKBUDDY_HOME?.trim() || undefined;
  return path.resolve(configured ?? path.join(os.homedir(), ".workbuddy"));
}

export function applyWorkBuddyMcpUrls(
  manifest: Record<string, unknown>,
  urls: EnvironmentUrls
): Record<string, unknown> {
  if (!isObject(manifest.mcpServers)) {
    throw new Error("WorkBuddy MCP 清单缺少 quick-image 配置，请先重新安装 Quick Image Plugin");
  }
  const servers = manifest.mcpServers;
  const entry = servers[QUICK_IMAGE_MCP_NAME];
  if (!isObject(entry) || Object.keys(entry).length === 0) {
    throw new Error("WorkBuddy MCP 清单缺少 quick-image 配置，请先重新安装 Quick Image Plugin");
  }
  const updatedEntry: Record<string, unknown> = { ...entry, url: urls.serverUrl };
  let touchedHeaderContainer = false;
  for (const container of HEADER_CONTAINERS) {
    const existing = updatedEntry[container];
    if (!isObject(existing)) continue;
    updatedEntry[container] = {
      ...existing,
      [QUICK_IMAGE_FRONTEND_HEADER]: urls.frontendUrl
    };
    touchedHeaderContainer = true;
  }
  if (!touchedHeaderContainer) {
    updatedEntry.headers = { [QUICK_IMAGE_FRONTEND_HEADER]: urls.frontendUrl };
  }
  return { ...manifest, mcpServers: { ...servers, [QUICK_IMAGE_MCP_NAME]: updatedEntry } };
}

export function verifyWorkBuddyManifest(
  original: Record<string, unknown>,
  rewritten: Record<string, unknown>,
  urls: EnvironmentUrls
): void {
  if (Object.keys(original).sort().join("\u0000") !== Object.keys(rewritten).sort().join("\u0000")) {
    throw new Error("WorkBuddy MCP 清单的顶层配置项被意外改动");
  }
  for (const key of Object.keys(original)) {
    if (key === "mcpServers") continue;
    if (JSON.stringify(original[key]) !== JSON.stringify(rewritten[key])) {
      throw new Error("WorkBuddy MCP 清单中 mcpServers 以外的配置被意外改动");
    }
  }
  const originalServers = isObject(original.mcpServers) ? original.mcpServers : {};
  const rewrittenServers = isObject(rewritten.mcpServers) ? rewritten.mcpServers : {};
  if (Object.keys(originalServers).sort().join("\u0000") !== Object.keys(rewrittenServers).sort().join("\u0000")) {
    throw new Error("WorkBuddy MCP 清单的服务器列表被意外改动");
  }
  for (const name of Object.keys(originalServers)) {
    if (name === QUICK_IMAGE_MCP_NAME) continue;
    if (JSON.stringify(originalServers[name]) !== JSON.stringify(rewrittenServers[name])) {
      throw new Error(`WorkBuddy MCP 清单中 ${name} 的配置被意外改动`);
    }
  }
  const entry = rewrittenServers[QUICK_IMAGE_MCP_NAME];
  if (!isObject(entry) || entry.url !== urls.serverUrl) {
    throw new Error("WorkBuddy 未加载刚写入的 Quick Image MCP 配置");
  }
  const containers = HEADER_CONTAINERS.filter((container) => isObject(entry[container]));
  if (containers.length === 0) {
    throw new Error("WorkBuddy 未加载刚写入的 Quick Image MCP 配置");
  }
  for (const container of containers) {
    const headers = entry[container];
    if (!isObject(headers) || headers[QUICK_IMAGE_FRONTEND_HEADER] !== urls.frontendUrl) {
      throw new Error("WorkBuddy 未加载刚写入的 Quick Image MCP 配置");
    }
  }
}

async function resolveWorkBuddyInstalls(home: string): Promise<WorkBuddyInstall[]> {
  const registry = await readOptionalJson(path.join(home, WORKBUDDY_REGISTRY_RELATIVE_PATH));
  if (!registry || !isObject(registry.plugins)) return [];
  const roots: string[] = [];
  for (const [key, entries] of Object.entries(registry.plugins)) {
    if (!workBuddyPluginKeyMatches(key) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.installPath !== "string") continue;
      const root = path.resolve(entry.installPath);
      if (!roots.some((existing) => samePath(existing, root))) roots.push(root);
    }
  }
  const installs: WorkBuddyInstall[] = [];
  for (const root of roots) {
    const mcpPaths = await resolveWorkBuddyMcpPaths(root);
    if (mcpPaths.length > 0) installs.push({ root, mcpPaths });
  }
  return installs;
}

// 注册表键形如 <plugin>@<marketplace>，按最后一个 @ 分隔取插件名。
function workBuddyPluginKeyMatches(key: string): boolean {
  const separator = key.lastIndexOf("@");
  const name = separator === -1 ? key : key.slice(0, separator);
  return name === QUICK_IMAGE_MCP_NAME;
}

async function resolveWorkBuddyMcpPaths(root: string): Promise<string[]> {
  const mcpPaths: string[] = [];
  for (const relativePath of WORKBUDDY_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(root, relativePath);
    const manifest = await readOptionalJson(manifestPath);
    if (!manifest) continue;
    if (typeof manifest.mcpServers !== "string") {
      throw new Error(`WorkBuddy 插件清单未通过文件配置 MCP：${manifestPath}`);
    }
    const mcpPath = path.resolve(root, manifest.mcpServers);
    if (!pathContains(root, mcpPath)) {
      throw new Error(`WorkBuddy MCP 清单路径超出插件目录：${manifest.mcpServers}`);
    }
    // 两份 manifest 可能指向同一清单文件（历史布局），去重避免重复写两遍。
    if (!mcpPaths.some((existing) => samePath(existing, mcpPath))) mcpPaths.push(mcpPath);
  }
  return mcpPaths;
}

async function readWorkBuddyMcpUrls(mcpPath: string): Promise<EnvironmentUrls | undefined> {
  let text: string;
  try {
    text = await readFile(mcpPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  // 清单损坏时按未配置上报而不是让 status 整体失败：与 Codex/OpenClaw 的
  // status 行为一致，set/reset 仍会对损坏文件显式报错。
  let manifest: Record<string, unknown>;
  try {
    manifest = parseJsonManifestText(text, mcpPath);
  } catch {
    return undefined;
  }
  const entry = isObject(manifest.mcpServers) ? manifest.mcpServers[QUICK_IMAGE_MCP_NAME] : undefined;
  if (!isObject(entry) || typeof entry.url !== "string") return undefined;
  const headers = isObject(entry.headers) ? entry.headers : {};
  const httpHeaders = isObject(entry.http_headers) ? entry.http_headers : {};
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER] ?? httpHeaders[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof frontendUrl !== "string") return undefined;
  return { serverUrl: entry.url, frontendUrl };
}

async function planWorkBuddyMcpUpdate(mcpPath: string, urls: EnvironmentUrls): Promise<WorkBuddyMcpUpdatePlan> {
  let details: Stats;
  try {
    details = await lstat(mcpPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) throw new Error(`找不到 WorkBuddy MCP 清单：${mcpPath}`);
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`拒绝修改符号链接形式的 WorkBuddy MCP 清单：${mcpPath}`);
  if (!details.isFile()) throw new Error(`WorkBuddy MCP 清单不是普通文件：${mcpPath}`);

  const originalText = await readFile(mcpPath, "utf8");
  const original = parseJsonManifestText(originalText, mcpPath);
  const updated = applyWorkBuddyMcpUrls(original, urls);
  const { mode } = await stat(mcpPath);
  return {
    mcpPath,
    originalText,
    original,
    updatedText: serializeJsonManifestText(updated, originalText),
    mode
  };
}

async function commitWorkBuddyMcpUpdate(plan: WorkBuddyMcpUpdatePlan, urls: EnvironmentUrls): Promise<void> {
  if (plan.originalText !== "") {
    await writeJsonManifestAtomic(`${plan.mcpPath}${WORKBUDDY_BACKUP_SUFFIX}`, plan.originalText, plan.mode);
  }
  await writeJsonManifestAtomic(plan.mcpPath, plan.updatedText, plan.mode);
  try {
    const rewritten = parseJsonManifestText(await readFile(plan.mcpPath, "utf8"), plan.mcpPath);
    verifyWorkBuddyManifest(plan.original, rewritten, urls);
  } catch (error) {
    await writeJsonManifestAtomic(plan.mcpPath, plan.originalText, plan.mode);
    throw error;
  }
}


async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw new Error(`无法读取文件：${filePath}`);
  }
  try {
    const value: unknown = JSON.parse(stripByteOrderMark(text));
    if (isObject(value)) return value;
  } catch {
    // 转译为下方统一错误。
  }
  throw new Error(`文件不是有效的 JSON 对象：${filePath}`);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function pathContains(root: string, child: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedRoot, resolvedChild);
  const escaped = relative === "" || relative.startsWith("..") || path.isAbsolute(relative);
  if (!escaped) return true;
  if (process.platform !== "win32") return false;
  // Windows 文件系统大小写不敏感，前缀判断需先对齐大小写。
  const caseInsensitive = path.relative(resolvedRoot.toLowerCase(), resolvedChild.toLowerCase());
  return caseInsensitive !== "" && !caseInsensitive.startsWith("..") && !path.isAbsolute(caseInsensitive);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
