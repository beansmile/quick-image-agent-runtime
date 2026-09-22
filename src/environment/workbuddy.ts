import { copyFile, lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

// WorkBuddy 没有 env 配置 CLI；它把插件 MCP 清单（.workbuddy-plugin/plugin.json
// 的 mcpServers 字段指向的文件，当前为 ./.mcp.json）从插件安装目录直接加载为
// custom-mcp 配置。因此环境切换通过改写插件安装目录内的该清单文件实现：
// 只更新 mcpServers.quick-image 的 url 与 X-Quick-Image-Frontend-URL 两个头，
// 其余配置语义保持不变，并按原文还原 BOM、缩进、行尾与结尾换行；写入前备份，
// 写入后回读校验，失败自动恢复原文，多安装时先整体规划再统一写入。
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
  mcpPath: string;
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
  // 无法解析时不会动任何文件；写入阶段中途失败时把已写入的安装回滚为原文，
  // 避免宿主按不同 scope 加载到混合环境。
  const plans = [];
  for (const install of installs) {
    plans.push(await planWorkBuddyMcpUpdate(install.mcpPath, urls));
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
      await writeAtomic(plan.mcpPath, plan.originalText, plan.mode).catch(() => undefined);
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
  // 多个安装（不同 scope）同时存在时取第一个可读出 quick-image 配置的文件；
  // set/reset 会同步更新全部安装，正常情况下不会出现不一致。
  for (const install of installs) {
    const urls = await readWorkBuddyMcpUrls(install.mcpPath);
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

export function serializeWorkBuddyManifestText(value: Record<string, unknown>, originalText: string): string {
  // Windows 工具写 JSON 可能带 UTF-8 BOM 且 JSON.parse 无法直接解析；
  // 序列化时按原文还原 BOM、缩进、行尾与结尾换行，尽量少改动无关字节。
  const byteOrderMark = originalText.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const lineEnding = originalText.includes("\r\n") ? "\r\n" : "\n";
  const serialized = serializeWithOriginalWhitespace(value, originalText);
  const body = lineEnding === "\r\n" ? serialized.replace(/\n/g, "\r\n") : serialized;
  const trailingNewline = originalText.endsWith("\n") ? lineEnding : "";
  return `${byteOrderMark}${body}${trailingNewline}`;
}

// JSON.stringify 的产物不含裸换行，逐个替换 \n 为 \r\n 不会破坏字符串内容。
function serializeWithOriginalWhitespace(value: Record<string, unknown>, originalText: string): string {
  const text = stripByteOrderMark(originalText);
  const firstLineBreak = text.indexOf("\n");
  // 原文没有换行，或唯一换行是结尾换行，说明是单行压缩格式，保持压缩。
  if (firstLineBreak === -1 || firstLineBreak === text.length - 1) return JSON.stringify(value);
  const indent = /^[ \t]+/.exec(text.slice(firstLineBreak + 1))?.[0];
  if (!indent) return JSON.stringify(value, null, 2);
  return JSON.stringify(value, null, indent.slice(0, 10));
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
    const mcpPath = await resolveWorkBuddyMcpPath(root);
    if (mcpPath) installs.push({ root, mcpPath });
  }
  return installs;
}

// 注册表键形如 <plugin>@<marketplace>，按最后一个 @ 分隔取插件名。
function workBuddyPluginKeyMatches(key: string): boolean {
  const separator = key.lastIndexOf("@");
  const name = separator === -1 ? key : key.slice(0, separator);
  return name === QUICK_IMAGE_MCP_NAME;
}

async function resolveWorkBuddyMcpPath(root: string): Promise<string | undefined> {
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
    return mcpPath;
  }
  return undefined;
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
    manifest = parseWorkBuddyManifestText(text, mcpPath);
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
  const original = parseWorkBuddyManifestText(originalText, mcpPath);
  const updated = applyWorkBuddyMcpUrls(original, urls);
  const { mode } = await stat(mcpPath);
  return {
    mcpPath,
    originalText,
    original,
    updatedText: serializeWorkBuddyManifestText(updated, originalText),
    mode
  };
}

async function commitWorkBuddyMcpUpdate(plan: WorkBuddyMcpUpdatePlan, urls: EnvironmentUrls): Promise<void> {
  if (plan.originalText !== "") {
    await writeAtomic(`${plan.mcpPath}${WORKBUDDY_BACKUP_SUFFIX}`, plan.originalText, plan.mode);
  }
  await writeAtomic(plan.mcpPath, plan.updatedText, plan.mode);
  try {
    const rewritten = parseWorkBuddyManifestText(await readFile(plan.mcpPath, "utf8"), plan.mcpPath);
    verifyWorkBuddyManifest(plan.original, rewritten, urls);
  } catch (error) {
    await writeAtomic(plan.mcpPath, plan.originalText, plan.mode);
    throw error;
  }
}

function parseWorkBuddyManifestText(text: string, source: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stripByteOrderMark(text));
    if (isObject(value)) return value;
  } catch {
    // 统一转译为带文件路径的错误，便于定位损坏的安装。
  }
  throw new Error(`WorkBuddy MCP 清单不是有效 JSON：${source}`);
}

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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

async function writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.quick-image-${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      // Windows 上宿主进程短暂占用目标文件时 rename 可能失败；退化为
      // copyFile+unlink，内容仍按整块覆盖，不会写出半个清单。
      await copyFile(temporaryPath, filePath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
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
