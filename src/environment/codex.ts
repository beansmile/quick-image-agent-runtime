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

const MANAGED_BLOCK_BEGIN = "# BEGIN quick-image managed MCP environment";
const MANAGED_BLOCK_END = "# END quick-image managed MCP environment";
const QUICK_IMAGE_TABLE_PATTERN = /^\s*\[\s*mcp_servers\s*\.\s*(?:quick-image|"quick-image"|'quick-image')\s*\]\s*(?:#.*)?$/m;

interface CodexOptions {
  runtimeVersion: string;
  codexBin?: string;
  configPath?: string;
  executor?: CommandExecutor;
}

export async function setCodexEnvironment(urls: EnvironmentUrls, options: CodexOptions): Promise<EnvironmentStatus> {
  if (!options.configPath) return setCodexManifestEnvironment(urls, options);
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const pluginVersion = readEffectiveCodexConfig(runtime)?.pluginVersion ?? options.runtimeVersion;
  const updated = upsertCodexManagedBlock(source, urls, pluginVersion);
  await writeCodexConfigAndVerify(runtime, source, updated, urls);
  return readCodexEnvironmentStatus(options);
}

export async function resetCodexEnvironment(options: CodexOptions): Promise<EnvironmentStatus> {
  if (!options.configPath) return resetCodexManifestEnvironment(options);
  const runtime = codexRuntime(options);
  const source = await readCodexConfig(runtime.configPath);
  const updated = removeCodexManagedBlock(source);
  if (updated !== source) await writeCodexConfigAndVerify(runtime, source, updated);

  const status = await readCodexEnvironmentStatus(options);
  if (status.configured && (
    status.serverUrl !== QUICK_IMAGE_PRODUCTION_SERVER_URL ||
    status.frontendUrl !== QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  )) {
    throw new Error("Codex 当前仍由其他配置提供自定义 Quick Image URL，env reset 无法安全覆盖该配置");
  }
  return status;
}

export async function readCodexEnvironmentStatus(options: CodexOptions): Promise<EnvironmentStatus> {
  if (!options.configPath) return readCodexManifestStatus(options);
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
  const range = managedBlockRange(source);
  if (!range && QUICK_IMAGE_TABLE_PATTERN.test(source)) {
    throw new Error("Codex config.toml 已包含非 Quick Image 管理的 mcp_servers.quick-image 配置；请先手工处理该冲突");
  }
  const block = renderManagedBlock(urls, runtimeVersion);
  if (range) return `${source.slice(0, range.start)}${block}${source.slice(range.end)}`;
  const prefix = source.length === 0 ? "" : `${source.replace(/\s*$/, "")}\n\n`;
  return `${prefix}${block}`;
}

export function removeCodexManagedBlock(source: string): string {
  const range = managedBlockRange(source);
  if (!range) return source;
  const separatorLength = source.slice(0, range.start).endsWith("\n\n") ? 1 : 0;
  const before = source.slice(0, range.start - separatorLength);
  const after = source.slice(range.end).replace(/^\n{2,}/, "\n");
  return `${before}${after}`;
}

export function containsManagedBlock(source: string): boolean {
  return managedBlockRange(source) !== undefined;
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

async function setCodexManifestEnvironment(urls: EnvironmentUrls, options: CodexOptions): Promise<EnvironmentStatus> {
  const root = await resolvePluginRoot(options);
  const files = [path.join(root, ".mcp.json"), path.join(root, "mcp.json")];
  const originals = await Promise.all(files.map((file) => readJsonFile(file)));
  try {
    await Promise.all(files.map((file, index) => writeJsonAtomic(file, updateManifest(originals[index]!, urls))));
  } catch (error) {
    await Promise.all(files.map((file, index) => writeJsonAtomic(file, originals[index]!)));
    throw error;
  }
  return { host: "codex", configured: true, source: "custom", ...urls, authenticationCommand: "codex mcp login quick-image" };
}

async function resetCodexManifestEnvironment(options: CodexOptions): Promise<EnvironmentStatus> {
  return setCodexManifestEnvironment({
    serverUrl: QUICK_IMAGE_PRODUCTION_SERVER_URL,
    frontendUrl: QUICK_IMAGE_PRODUCTION_FRONTEND_URL
  }, options);
}

async function readCodexManifestStatus(options: CodexOptions): Promise<EnvironmentStatus> {
  try {
    const manifest = await readJsonFile(path.join(await resolvePluginRoot(options), ".mcp.json"));
    const servers = isObject(manifest.mcpServers) ? manifest.mcpServers : {};
    const server = isObject(servers[QUICK_IMAGE_MCP_NAME]) ? servers[QUICK_IMAGE_MCP_NAME] : {};
    const headers = isObject(server.headers) ? server.headers : {};
    if (typeof server.url !== "string" || typeof headers[QUICK_IMAGE_FRONTEND_HEADER] !== "string") {
      return { host: "codex", configured: false, source: "missing" };
    }
    const production = server.url === QUICK_IMAGE_PRODUCTION_SERVER_URL &&
      headers[QUICK_IMAGE_FRONTEND_HEADER] === QUICK_IMAGE_PRODUCTION_FRONTEND_URL;
    return {
      host: "codex", configured: true, source: production ? "plugin-default" : "custom",
      serverUrl: server.url, frontendUrl: headers[QUICK_IMAGE_FRONTEND_HEADER],
      authenticationCommand: "codex mcp login quick-image"
    };
  } catch {
    return { host: "codex", configured: false, source: "missing" };
  }
}

async function resolvePluginRoot(options: CodexOptions): Promise<string> {
  const runtime = codexRuntime(options);
  const output = runtime.executor.run(runtime.codexBin, ["plugin", "list", "--json"]).stdout;
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("Codex Plugin 列表输出不是有效 JSON"); }
  if (!isObject(value) || !Array.isArray(value.installed)) throw new Error("Codex Plugin 列表输出格式无效");
  const matches = value.installed.filter((item) => isObject(item) && item.name === "quick-image" && item.enabled !== false);
  if (matches.length !== 1 || !isObject(matches[0]) || !isObject(matches[0].source) || typeof matches[0].source.path !== "string") {
    throw new Error("无法从 Codex Plugin 列表定位唯一且已启用的 quick-image 安装目录");
  }
  return path.resolve(matches[0].source.path);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>; }
  catch (error) {
    if (isFileSystemError(error, "ENOENT")) throw new Error(`找不到 Codex MCP 清单：${filePath}`);
    throw new Error(`无法读取 Codex MCP 清单：${filePath}`);
  }
}

function updateManifest(source: Record<string, unknown>, urls: EnvironmentUrls): Record<string, unknown> {
  const servers = isObject(source.mcpServers) ? { ...source.mcpServers } : {};
  const current = isObject(servers[QUICK_IMAGE_MCP_NAME]) ? { ...servers[QUICK_IMAGE_MCP_NAME] } : {};
  const headers = isObject(current.headers) ? { ...current.headers } : {};
  headers[QUICK_IMAGE_FRONTEND_HEADER] = urls.frontendUrl;
  servers[QUICK_IMAGE_MCP_NAME] = { ...current, url: urls.serverUrl, headers };
  if (isObject(current.http_headers) || source === undefined) {
    const httpHeaders = isObject(current.http_headers) ? { ...current.http_headers } : {};
    httpHeaders[QUICK_IMAGE_FRONTEND_HEADER] = urls.frontendUrl;
    (servers[QUICK_IMAGE_MCP_NAME] as Record<string, unknown>).http_headers = httpHeaders;
  }
  return { ...source, mcpServers: servers };
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
  const codexHome = process.env.CODEX_HOME?.trim();
  return path.join(codexHome ? path.resolve(codexHome) : path.join(os.homedir(), ".codex"), "config.toml");
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
