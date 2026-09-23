import { lstat, readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { resolveCodexExecutable } from "./executables.js";
import { parseJsonManifestText, serializeJsonManifestText, writeJsonManifestAtomic } from "./json-manifest.js";

// Codex 从插件安装目录的 MCP 清单加载 quick-image 远程配置（2026-09-23 实测：
// 生效来源是 plugins/cache 安装缓存，.tmp/marketplaces 工作副本不直接生效、
// 只作为缓存重建来源，两处都写以保持重建后一致）。环境切换因此与 WorkBuddy
// 同机制：定位 Marketplace 工作副本与安装缓存两个根目录，同步改写各自的
// MCP 清单（.codex-plugin/plugin.json 指向的 .mcp.json 与兼容布局 mcp.json），
// 只更新 mcpServers.quick-image 的 url 与 X-Quick-Image-Frontend-URL 两个头，
// 其余配置语义保持不变，并按原文还原 BOM、缩进、行尾与结尾换行；写入前备份，
// 写入后回读校验，失败自动恢复原文，多清单时先整体规划再统一写入。
// 不读写 ~/.codex/config.toml，也不处理其历史管理块残留：用户级配置若覆盖
// 插件清单，写入后的生效校验会显式报错。
const CODEX_BACKUP_SUFFIX = ".quick-image-backup";
const HEADER_CONTAINERS = ["headers", "http_headers"] as const;

interface CodexOptions {
  codexBin?: string;
  executor?: CommandExecutor;
}

interface CodexRuntime {
  codexBin: string;
  executor: CommandExecutor;
}

interface CodexManifestUpdatePlan {
  filePath: string;
  originalText: string;
  original: Record<string, unknown>;
  updatedText: string;
  mode: number;
}

export async function setCodexEnvironment(urls: EnvironmentUrls, options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  // 先完成两个根目录全部清单的解析与改写计算再统一写入：任何一份清单无法
  // 解析时不会动任何文件；写入阶段中途失败时把已写入的清单回滚为原文，
  // 避免不同根目录加载到混合环境。
  const plans: CodexManifestUpdatePlan[] = [];
  for (const root of resolvePluginRoots(runtime)) {
    for (const filePath of await resolvePluginManifestFiles(root)) {
      plans.push(await planCodexManifestUpdate(filePath, urls));
    }
  }
  const committed: CodexManifestUpdatePlan[] = [];
  try {
    for (const plan of plans) {
      await commitCodexManifestUpdate(plan, urls);
      committed.push(plan);
    }
  } catch (error) {
    // 回滚失败时保留各清单的备份文件供人工恢复，原始错误仍然如实上抛。
    for (const plan of committed) {
      await writeJsonManifestAtomic(plan.filePath, plan.originalText, plan.mode).catch(() => undefined);
    }
    throw error;
  }
  verifyCodexEffectiveConfig(runtime, urls);
  return readCodexEnvironmentStatus(options);
}

export async function resetCodexEnvironment(options: CodexOptions): Promise<EnvironmentStatus> {
  return setCodexEnvironment({
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  }, options);
}

export async function readCodexEnvironmentStatus(options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  let output: string;
  try {
    output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]).stdout;
  } catch {
    return { host: "codex", configured: false, source: "missing" };
  }
  const config = parseCodexMcpOutput(JSON.parse(output));
  const usesProduction = config.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
    config.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
  return {
    host: "codex",
    configured: true,
    source: usesProduction ? "plugin-default" : "custom",
    serverUrl: config.serverUrl,
    frontendUrl: config.frontendUrl,
    authenticationCommand: "codex mcp login quick-image"
  };
}

function applyCodexManifestUrls(
  manifest: Record<string, unknown>,
  urls: EnvironmentUrls
): Record<string, unknown> {
  if (!isObject(manifest.mcpServers)) {
    throw new Error("Codex MCP 清单缺少 quick-image 配置，请先重新安装 Quick Image Plugin");
  }
  const servers = manifest.mcpServers;
  const entry = servers[QUICK_IMAGE_MCP_NAME];
  if (!isObject(entry) || Object.keys(entry).length === 0) {
    throw new Error("Codex MCP 清单缺少 quick-image 配置，请先重新安装 Quick Image Plugin");
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

function verifyCodexManifest(
  original: Record<string, unknown>,
  rewritten: Record<string, unknown>,
  urls: EnvironmentUrls
): void {
  if (Object.keys(original).sort().join("\u0000") !== Object.keys(rewritten).sort().join("\u0000")) {
    throw new Error("Codex MCP 清单的顶层配置项被意外改动");
  }
  for (const key of Object.keys(original)) {
    if (key === "mcpServers") continue;
    if (JSON.stringify(original[key]) !== JSON.stringify(rewritten[key])) {
      throw new Error("Codex MCP 清单中 mcpServers 以外的配置被意外改动");
    }
  }
  const originalServers = isObject(original.mcpServers) ? original.mcpServers : {};
  const rewrittenServers = isObject(rewritten.mcpServers) ? rewritten.mcpServers : {};
  if (Object.keys(originalServers).sort().join("\u0000") !== Object.keys(rewrittenServers).sort().join("\u0000")) {
    throw new Error("Codex MCP 清单的服务器列表被意外改动");
  }
  for (const name of Object.keys(originalServers)) {
    if (name === QUICK_IMAGE_MCP_NAME) continue;
    if (JSON.stringify(originalServers[name]) !== JSON.stringify(rewrittenServers[name])) {
      throw new Error(`Codex MCP 清单中 ${name} 的配置被意外改动`);
    }
  }
  const entry = rewrittenServers[QUICK_IMAGE_MCP_NAME];
  if (!isObject(entry) || entry.url !== urls.serverUrl) {
    throw new Error("Codex MCP 清单回读校验失败：quick-image 条目未指向目标地址");
  }
  const containers = HEADER_CONTAINERS.filter((container) => isObject(entry[container]));
  if (containers.length === 0) {
    throw new Error("Codex MCP 清单回读校验失败：quick-image 条目缺少前端地址头");
  }
  for (const container of containers) {
    const headers = entry[container];
    if (!isObject(headers) || headers[QUICK_IMAGE_FRONTEND_HEADER] !== urls.frontendUrl) {
      throw new Error("Codex MCP 清单回读校验失败：quick-image 条目的前端地址头与预期不一致");
    }
  }
}

async function planCodexManifestUpdate(filePath: string, urls: EnvironmentUrls): Promise<CodexManifestUpdatePlan> {
  let details: Stats;
  try {
    details = await lstat(filePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) throw new Error(`找不到 Codex MCP 清单：${filePath}`);
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`拒绝修改符号链接形式的 Codex MCP 清单：${filePath}`);
  if (!details.isFile()) throw new Error(`Codex MCP 清单不是普通文件：${filePath}`);

  const originalText = await readFile(filePath, "utf8");
  const original = parseJsonManifestText(originalText, filePath);
  const updated = applyCodexManifestUrls(original, urls);
  const { mode } = await stat(filePath);
  return {
    filePath,
    originalText,
    original,
    updatedText: serializeJsonManifestText(updated, originalText),
    mode
  };
}

async function commitCodexManifestUpdate(plan: CodexManifestUpdatePlan, urls: EnvironmentUrls): Promise<void> {
  if (plan.originalText !== "") {
    await writeJsonManifestAtomic(`${plan.filePath}${CODEX_BACKUP_SUFFIX}`, plan.originalText, plan.mode);
  }
  await writeJsonManifestAtomic(plan.filePath, plan.updatedText, plan.mode);
  try {
    const rewritten = parseJsonManifestText(await readFile(plan.filePath, "utf8"), plan.filePath);
    verifyCodexManifest(plan.original, rewritten, urls);
  } catch (error) {
    await writeJsonManifestAtomic(plan.filePath, plan.originalText, plan.mode);
    throw error;
  }
}

function verifyCodexEffectiveConfig(runtime: CodexRuntime, urls: EnvironmentUrls): void {
  // 清单已写入且回读校验通过；此处校验 Codex 实际加载的生效配置。用户级
  // MCP 配置覆盖插件清单时如实报错而不是回滚清单——清单内容是正确的，
  // 冲突来源在宿主配置。
  const output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]);
  const actual = parseCodexMcpOutput(JSON.parse(output.stdout));
  if (actual.serverUrl !== urls.serverUrl || actual.frontendUrl !== urls.frontendUrl) {
    throw new Error("Codex 未加载刚写入的 Quick Image MCP 配置；若存在用户级 MCP 配置，请先通过 codex mcp remove quick-image 移除后重试");
  }
}

function resolvePluginRoots(runtime: CodexRuntime): string[] {
  const output = runtime.executor.run(runtime.codexBin, ["plugin", "list", "--json"]).stdout;
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("Codex Plugin 列表输出不是有效 JSON"); }
  if (!isObject(value) || !Array.isArray(value.installed)) throw new Error("Codex Plugin 列表输出格式无效");
  const matches = value.installed.filter((item) => isObject(item) && item.name === "quick-image" && item.enabled !== false);
  if (matches.length !== 1 || !isObject(matches[0]) || !isObject(matches[0].source) ||
      typeof matches[0].source.path !== "string" || typeof matches[0].marketplaceName !== "string" ||
      typeof matches[0].name !== "string" || typeof matches[0].version !== "string") {
    throw new Error("无法从 Codex Plugin 列表定位唯一且已启用的 quick-image 安装目录");
  }
  const marketplaceName = safePluginPathSegment(matches[0].marketplaceName, "Marketplace 名称");
  const pluginName = safePluginPathSegment(matches[0].name, "Plugin 名称");
  const version = safePluginPathSegment(matches[0].version, "Plugin 版本");
  const marketplaceRoot = path.resolve(matches[0].source.path);
  const cacheRoot = path.join(resolveCodexHome(), "plugins", "cache", marketplaceName, pluginName, version);
  return [...new Set([marketplaceRoot, cacheRoot])];
}

async function resolvePluginManifestFiles(root: string): Promise<string[]> {
  const pluginManifestPath = path.join(root, ".codex-plugin", "plugin.json");
  const pluginManifest = await readJsonFile(pluginManifestPath);
  if (typeof pluginManifest.mcpServers !== "string") {
    throw new Error(`Codex Plugin 清单未通过文件配置 MCP：${pluginManifestPath}`);
  }
  const resolvedRoot = path.resolve(root);
  const codexMcpPath = path.resolve(resolvedRoot, pluginManifest.mcpServers);
  if (codexMcpPath !== resolvedRoot && !codexMcpPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Codex MCP 清单路径超出 Plugin 目录：${pluginManifest.mcpServers}`);
  }
  // mcp.json 是兼容布局候选，旧安装可能没有：缺失时跳过而不是让切换失败。
  const legacyPath = path.join(root, "mcp.json");
  const files = [codexMcpPath];
  if (path.resolve(legacyPath) !== codexMcpPath && await fileExists(legacyPath)) files.push(legacyPath);
  return files;
}

function safePluginPathSegment(value: string, label: string): string {
  if (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Codex ${label}不是安全的路径段：${value}`);
  }
  return value;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>; }
  catch (error) {
    if (isFileSystemError(error, "ENOENT")) throw new Error(`找不到 Codex 插件清单：${filePath}`);
    throw new Error(`无法读取 Codex 插件清单：${filePath}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function codexRuntime(options: CodexOptions): CodexRuntime {
  return {
    codexBin: resolveCodexExecutable(options.codexBin),
    executor: options.executor ?? systemCommandExecutor
  };
}

function resolveCodexHome(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? path.resolve(codexHome) : path.join(os.homedir(), ".codex");
}

function parseCodexMcpOutput(value: unknown): EnvironmentUrls {
  if (!isObject(value) || !isObject(value.transport)) throw new Error("Codex MCP 状态输出无效");
  const headers = isObject(value.transport.http_headers) ? value.transport.http_headers : {};
  const serverUrl = value.transport.url;
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof serverUrl !== "string" || typeof frontendUrl !== "string") {
    throw new Error("Codex Quick Image MCP 缺少 Server URL 或 Frontend URL");
  }
  return { serverUrl, frontendUrl };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
