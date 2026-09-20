import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandExecutor } from "./command-executor.js";
import { systemCommandExecutor } from "./command-executor.js";
import {
  QUICK_IMAGE_FRONTEND_HEADER,
  QUICK_IMAGE_MCP_NAME,
  QUICK_IMAGE_PRODUCTION_FRONTEND_URL,
  QUICK_IMAGE_PRODUCTION_SERVER_URL,
  QUICK_IMAGE_VERSION_HEADER,
  type EnvironmentStatus,
  type EnvironmentUrls
} from "./config.js";
import { resolveCodexExecutable } from "./executables.js";

export const MANAGED_BLOCK_BEGIN = "# BEGIN quick-image managed MCP environment";
export const MANAGED_BLOCK_END = "# END quick-image managed MCP environment";
const QUICK_IMAGE_TABLE_PATTERN = /^\s*\[\s*mcp_servers\s*\.\s*(?:quick-image|"quick-image"|'quick-image')\s*\]\s*(?:#.*)?$/m;

interface CodexOptions {
  runtimeVersion: string;
  codexBin?: string;
  configPath?: string;
  executor?: CommandExecutor;
}

export async function setCodexEnvironment(urls: EnvironmentUrls, options: CodexOptions): Promise<EnvironmentStatus> {
  await restoreLegacyCodexManifests(options);
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const pluginVersion = readEffectiveCodexConfig(runtime)?.pluginVersion ?? options.runtimeVersion;
  const updated = upsertCodexManagedBlock(source, urls, pluginVersion);
  await writeCodexConfigAndVerify(runtime, source, updated, urls);
  return readCodexEnvironmentStatus(options);
}

export async function resetCodexEnvironment(options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const updated = removeCodexManagedBlock(source);
  if (updated !== source) await writeCodexConfigAndVerify(runtime, source, updated);

  let status = await readCodexEnvironmentStatus(options);
  if (status.configured && (
    status.serverUrl !== QUICK_IMAGE_PRODUCTION_SERVER_URL ||
    status.frontendUrl !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  )) {
    const repaired = await restoreLegacyCodexManifests(options);
    if (repaired) status = await readCodexEnvironmentStatus(options);
  }
  if (status.configured && (
    status.serverUrl !== QUICK_IMAGE_PRODUCTION_SERVER_URL ||
    status.frontendUrl !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  )) {
    throw new Error("Codex 当前仍由其他配置提供自定义 Quick Image URL，env reset 无法安全覆盖该配置");
  }
  return status;
}

export async function readCodexEnvironmentStatus(options: CodexOptions): Promise<EnvironmentStatus> {
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  let output: string;
  try {
    output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]).stdout;
  } catch {
    return { host: "codex", configured: false, source: "missing" };
  }
  const config = parseCodexMcpOutput(JSON.parse(output));
  return {
    host: "codex",
    configured: true,
    source: containsManagedBlock(source)
      ? "custom"
      : config.serverUrl === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
          config.frontendUrl === QUICK_IMAGE_PRODUCTION_FRONTEND_URL
        ? "plugin-default"
        : "external",
    serverUrl: config.serverUrl,
    frontendUrl: config.frontendUrl,
    authenticationCommand: "codex mcp login quick-image"
  };
}

export function upsertCodexManagedBlock(
  source: string,
  urls: EnvironmentUrls,
  runtimeVersion: string
): string {
  const prepared = prepareSourceForUpsert(source);
  const block = renderManagedBlock(urls, runtimeVersion);
  const range = (() => {
    try { return managedBlockRange(prepared); } catch { return undefined; }
  })();
  if (range) return `${prepared.slice(0, range.start)}${block}${prepared.slice(range.end)}`;
  const prefix = prepared.length === 0 ? "" : `${prepared.replace(/\s*$/, "")}\n\n`;
  return `${prefix}${block}`;
}

export function removeCodexManagedBlock(source: string): string {
  let range: { start: number; end: number } | undefined;
  try {
    range = managedBlockRange(source);
  } catch (error) {
    // 标记损坏：能按指纹识别出我们写入的表就救援删除，否则保持原样，
    // 由 reset 的回落验证兜底报错。
    return repairDamagedManagedSection(source) ?? source;
  }
  if (range) {
    const separatorLength = source.slice(0, range.start).endsWith("\n\n") ? 1 : 0;
    const before = source.slice(0, range.start - separatorLength);
    const after = source.slice(range.end).replace(/^\n{2,}/, "\n");
    return `${before}${after}`;
  }
  return repairDamagedManagedSection(source) ?? source;
}

export function containsManagedBlock(source: string): boolean {
  let marked = false;
  try {
    marked = managedBlockRange(source) !== undefined;
  } catch {
    // 标记损坏时按表体指纹判断，status 不因损坏而失败。
  }
  if (marked) return true;
  const tableRange = quickImageTableRange(source);
  return tableRange !== undefined && isManagedQuickImageTable(source, tableRange);
}

// 标记行可能被其他工具或手工编辑破坏；我们写入的区块有稳定的内容指纹
// （oauth_resource 行与 X-Quick-Image 头只会由 renderManagedBlock 同时产生），
// 据此可以安全识别并清理损坏残留，避免用户陷入无法恢复正式环境的死角。
// 指纹不匹配（更像用户手写配置）时返回 undefined，由调用方拒绝操作。
function repairDamagedManagedSection(source: string): string | undefined {
  const tableRange = quickImageTableRange(source);
  if (tableRange === undefined || !isManagedQuickImageTable(source, tableRange)) return undefined;
  const lines = source.split("\n");
  const headerLine = lineIndexOf(source, tableRange.start);
  // END 标记若残留在表体与下一个表头之间，会随表体一并删除；BEGIN 若还在，
  // 只可能紧贴表头上方（允许隔着空行）且独占一行——我们只会这样写标记。
  // 出现在别处或多行字符串内部的标记字样不属于本次写入的残留，保持原样。
  let candidate = headerLine - 1;
  while (candidate >= 0 && (lines[candidate] ?? "").trim() === "") candidate -= 1;
  const removeStart = candidate >= 0 && (lines[candidate] ?? "").trim() === MANAGED_BLOCK_BEGIN
    ? lines.slice(0, candidate).join("\n").length + (candidate > 0 ? 1 : 0)
    : tableRange.start;
  // 拼接处逐字节保留原有内容与空行；仅当删除发生在文件末尾时，才把遗留
  // 的尾部空行收敛为一个换行。文件其他位置（包括多行字符串内部）不动。
  const before = source.slice(0, removeStart);
  const after = source.slice(tableRange.end);
  return after === "" ? before.replace(/(?:[ \t]*\n)+$/, "\n") : `${before}${after}`;
}

function quickImageTableRange(source: string): { start: number; end: number } | undefined {
  QUICK_IMAGE_TABLE_PATTERN.lastIndex = 0;
  const match = QUICK_IMAGE_TABLE_PATTERN.exec(source);
  if (!match || match.index === undefined) return undefined;
  // pattern 的 ^\s* 可吞掉表头前的换行与空白，match.index 不一定指向 "["；
  // 一切定位都基于 "[" 的真实位置，否则会把主表头误认成下一个表头。
  const bracketOffset = match[0]?.indexOf("[") ?? -1;
  if (bracketOffset < 0) return undefined;
  const bracketIndex = match.index + bracketOffset;
  const start = lineStart(source, bracketIndex);
  const headerLineEnd = source.indexOf("\n", bracketIndex);
  let searchFrom = headerLineEnd === -1 ? source.length : headerLineEnd + 1;
  let end = source.length;
  // 表体延伸到下一个顶格表头；http_headers 被第三方工具展开成
  // [mcp_servers.quick-image.*] 子表时一并纳入，避免救援后留下孤儿配置。
  for (;;) {
    const rest = source.slice(searchFrom);
    const nextHeader = /^\[/m.exec(rest);
    if (!nextHeader || nextHeader.index === undefined) break;
    const headerStart = searchFrom + nextHeader.index;
    const lineBreak = source.indexOf("\n", headerStart);
    const headerLine = source.slice(headerStart, lineBreak === -1 ? source.length : lineBreak);
    if (!isQuickImageSubTableHeader(headerLine)) {
      end = headerStart;
      break;
    }
    searchFrom = headerStart + 1;
  }
  return { start, end };
}

function isQuickImageSubTableHeader(line: string): boolean {
  return /^\[\s*mcp_servers\s*\.\s*(?:quick-image|"quick-image"|'quick-image')\s*\./.test(line);
}

function isManagedQuickImageTable(source: string, range: { start: number; end: number }): boolean {
  // 指纹是两个带 Quick-Image 前缀的私有头：它们只会出现在指向 Quick Image
  // 的自定义 MCP 配置中，同时出现即认定归属。刻意不依赖 oauth_resource 等
  // Codex 通用契约键——表体被手改后它们可能缺失，不应因此放弃救援。
  const body = source.slice(range.start, range.end);
  return body.includes(QUICK_IMAGE_FRONTEND_HEADER) && body.includes(QUICK_IMAGE_VERSION_HEADER);
}

function prepareSourceForUpsert(source: string): string {
  let range: { start: number; end: number } | undefined;
  try {
    range = managedBlockRange(source);
  } catch (error) {
    const repaired = repairDamagedManagedSection(source);
    if (repaired === undefined) throw error;
    return repaired;
  }
  if (range) return source;
  if (QUICK_IMAGE_TABLE_PATTERN.test(source)) {
    const tableRange = quickImageTableRange(source);
    if (tableRange === undefined || !isManagedQuickImageTable(source, tableRange)) {
      throw new Error("Codex config.toml 已包含非 Quick Image 管理的 mcp_servers.quick-image 配置；请先手工处理该冲突");
    }
    return repairDamagedManagedSection(source)!;
  }
  return source;
}

function renderManagedBlock(urls: EnvironmentUrls, runtimeVersion: string): string {
  return [
    MANAGED_BLOCK_BEGIN,
    `[mcp_servers.${QUICK_IMAGE_MCP_NAME}]`,
    `url = ${tomlString(urls.serverUrl)}`,
    `oauth_resource = ${tomlString(urls.serverUrl)}`,
    'auth = "oauth"',
    `http_headers = { ${tomlString(QUICK_IMAGE_VERSION_HEADER)} = ${tomlString(runtimeVersion)}, ${tomlString(QUICK_IMAGE_FRONTEND_HEADER)} = ${tomlString(urls.frontendUrl)} }`,
    MANAGED_BLOCK_END,
    ""
  ].join("\n");
}

function managedBlockRange(source: string): { start: number; end: number } | undefined {
  const begins = markerIndexes(source, MANAGED_BLOCK_BEGIN);
  const ends = markerIndexes(source, MANAGED_BLOCK_END);
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || begins[0] === undefined || ends[0] === undefined) {
    throw new Error("Codex config.toml 中的 Quick Image 管理区块标记不完整或重复");
  }
  if (begins[0] >= ends[0]) throw new Error("Codex config.toml 中的 Quick Image 管理区块顺序无效");
  const start = lineStart(source, begins[0]);
  const endLine = source.indexOf("\n", ends[0]);
  return { start, end: endLine === -1 ? source.length : endLine + 1 };
}

function markerIndexes(source: string, marker: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset < source.length) {
    const index = source.indexOf(marker, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + marker.length;
  }
  return indexes;
}

function lineStart(source: string, index: number): number {
  const previousNewline = source.lastIndexOf("\n", index - 1);
  return previousNewline === -1 ? 0 : previousNewline + 1;
}

function lineIndexOf(source: string, charIndex: number): number {
  let line = 0;
  for (let index = 0; index < charIndex; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexRuntime(options: CodexOptions) {
  return {
    codexBin: resolveCodexExecutable(options.codexBin),
    configPath: options.configPath ?? resolveCodexConfigPath(),
    executor: options.executor ?? systemCommandExecutor
  };
}

// 旧版 Runtime 曾通过直接改写插件清单切换环境，Codex 重建缓存前该修改会残留。
// 新版唯一的环境覆盖来源是上面的管理区块；这里把清单中遗留的非正式地址归位
// 为与插件发布默认一致的正式地址，保证 env reset 能干净回落。仅允许写入正式
// 默认值，任何失败都作为“未修复”返回而不阻断主流程。
async function restoreLegacyCodexManifests(options: CodexOptions): Promise<boolean> {
  try {
    const roots = await resolvePluginRoots(options);
    let repaired = false;
    for (const root of roots) {
      for (const file of await resolvePluginManifestFiles(root)) {
        const manifest = await readJsonFile(file);
        if (!manifestNeedsRestore(manifest)) continue;
        await writeJsonAtomic(file, restoreManifestToProduction(manifest));
        repaired = true;
      }
    }
    return repaired;
  } catch {
    return false;
  }
}

function manifestNeedsRestore(manifest: Record<string, unknown>): boolean {
  const servers = isObject(manifest.mcpServers) ? manifest.mcpServers : {};
  const current = isObject(servers[QUICK_IMAGE_MCP_NAME]) ? servers[QUICK_IMAGE_MCP_NAME] : {};
  if (!isObject(current) || Object.keys(current).length === 0) return false;
  const headers = isObject(current.headers) ? current.headers : {};
  const httpHeaders = isObject(current.http_headers) ? current.http_headers : undefined;
  return current.url !== QUICK_IMAGE_PRODUCTION_SERVER_URL ||
    headers[QUICK_IMAGE_FRONTEND_HEADER] !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL ||
    (httpHeaders !== undefined && httpHeaders[QUICK_IMAGE_FRONTEND_HEADER] !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL);
}

function restoreManifestToProduction(manifest: Record<string, unknown>): Record<string, unknown> {
  const servers = isObject(manifest.mcpServers) ? { ...manifest.mcpServers } : {};
  const current = isObject(servers[QUICK_IMAGE_MCP_NAME]) ? { ...servers[QUICK_IMAGE_MCP_NAME] } : {};
  const restored: Record<string, unknown> = {
    ...current,
    url: QUICK_IMAGE_PRODUCTION_SERVER_URL
  };
  const headers = isObject(current.headers) ? { ...current.headers } : {};
  headers[QUICK_IMAGE_FRONTEND_HEADER] = QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
  restored.headers = headers;
  if (isObject(current.http_headers)) {
    const httpHeaders = { ...current.http_headers };
    httpHeaders[QUICK_IMAGE_FRONTEND_HEADER] = QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
    restored.http_headers = httpHeaders;
  }
  servers[QUICK_IMAGE_MCP_NAME] = restored;
  return { ...manifest, mcpServers: servers };
}

async function resolvePluginRoots(options: CodexOptions): Promise<string[]> {
  const runtime = codexRuntime(options);
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
  return [...new Set([codexMcpPath, path.join(root, "mcp.json")])];
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
    if (isFileSystemError(error, "ENOENT")) throw new Error(`找不到 Codex MCP 清单：${filePath}`);
    throw new Error(`无法读取 Codex MCP 清单：${filePath}`);
  }
}

async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.quick-image-${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function readEffectiveCodexConfig(runtime: ReturnType<typeof codexRuntime>): CodexMcpConfig | undefined {
  try {
    const output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]);
    return parseCodexMcpOutput(JSON.parse(output.stdout));
  } catch {
    return undefined;
  }
}

function resolveCodexConfigPath(): string {
  return path.join(resolveCodexHome(), "config.toml");
}

function resolveCodexHome(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? path.resolve(codexHome) : path.join(os.homedir(), ".codex");
}

async function readCodexConfig(configPath: string): Promise<string> {
  try {
    const details = await lstat(configPath);
    if (details.isSymbolicLink()) throw new Error(`拒绝修改符号链接形式的 Codex 配置：${configPath}`);
    if (!details.isFile()) throw new Error(`Codex 配置不是普通文件：${configPath}`);
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return "";
    throw error;
  }
}

async function writeCodexConfigAndVerify(
  runtime: ReturnType<typeof codexRuntime>,
  original: string,
  updated: string,
  expected?: EnvironmentUrls
): Promise<void> {
  if (original !== "") {
    await writeAtomic(`${runtime.configPath}.quick-image-backup`, original);
  }
  await writeAtomic(runtime.configPath, updated);
  try {
    runtime.executor.run(runtime.codexBin, ["mcp", "list", "--json"]);
    if (expected) {
      const output = runtime.executor.run(runtime.codexBin, ["mcp", "get", QUICK_IMAGE_MCP_NAME, "--json"]);
      const actual = parseCodexMcpOutput(JSON.parse(output.stdout));
      if (actual.serverUrl !== expected.serverUrl || actual.frontendUrl !== expected.frontendUrl) {
        throw new Error("Codex 未加载刚写入的 Quick Image MCP 配置");
      }
    }
  } catch (error) {
    await restoreCodexConfig(runtime.configPath, original);
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.quick-image-${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function restoreCodexConfig(filePath: string, original: string): Promise<void> {
  if (original === "") {
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    return;
  }
  await writeAtomic(filePath, original);
}

interface CodexMcpConfig extends EnvironmentUrls {
  pluginVersion?: string;
}

function parseCodexMcpOutput(value: unknown): CodexMcpConfig {
  if (!isObject(value) || !isObject(value.transport)) throw new Error("Codex MCP 状态输出无效");
  const headers = isObject(value.transport.http_headers) ? value.transport.http_headers : {};
  const serverUrl = value.transport.url;
  const frontendUrl = headers[QUICK_IMAGE_FRONTEND_HEADER];
  if (typeof serverUrl !== "string" || typeof frontendUrl !== "string") {
    throw new Error("Codex Quick Image MCP 缺少 Server URL 或 Frontend URL");
  }
  const pluginVersion = headers[QUICK_IMAGE_VERSION_HEADER];
  return {
    serverUrl,
    frontendUrl,
    ...(typeof pluginVersion === "string" ? { pluginVersion } : {})
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
