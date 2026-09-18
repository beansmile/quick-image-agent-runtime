import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import {
  MAX_PREVIEW_DOWNLOAD_BYTES,
  PREVIEW_CACHE_CLEANUP_THRESHOLD_BYTES,
  PREVIEW_DOWNLOAD_TIMEOUT_MS
} from "../constants.js";
import { PluginError } from "../errors.js";
import { detectMedia } from "../media/detect.js";
import { ensurePrivateDirectory, type PrivateDirectoryPolicy } from "../security/private-directory.js";
import type { SupportedMediaFormat } from "../types.js";

export interface CachedPreviewMedia {
  filePath: string;
  contentType: string;
  bytes: number;
}

export interface PreviewFetchResponse {
  status: number;
  contentLength: string | undefined;
  body: AsyncIterable<Buffer>;
  close(error?: Error): void;
}

/**
 * 拉取预览媒体。`signal` 在总超时或放弃下载时触发：实现必须用它销毁底层请求，
 * 包括响应头尚未到达的阶段——socket 空闲超时会被慢滴流源不断重置，只有显式
 * 销毁才能保证连接不泄漏。
 */
export type PreviewFetcher = (url: URL, signal: AbortSignal) => Promise<PreviewFetchResponse>;

const PREVIEW_IMAGE_FORMATS = new Set<SupportedMediaFormat>(["jpeg", "png", "webp"]);
const PREVIEW_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
// 缓存文件名 = sha256(display_url 完整字符串) + 检测出的扩展名；不符合该规则的文件视为遗留垃圾。
const CACHE_FILE_PATTERN = /^[0-9a-f]{64}\.(jpg|png|webp)$/;
const PREVIEW_CACHE_DIRECTORY_POLICY: PrivateDirectoryPolicy = {
  code: "INSECURE_PREVIEW_CACHE_DIRECTORY",
  message: "本地预览缓存目录不安全。",
  suggestedAction: "删除不安全的预览缓存目录（preview-cache）后重试；或改为直接发送原图链接文本。"
};

/**
 * 把任务结果的预览媒体受约束地下载到私有缓存目录，供宿主以本地文件投递。
 *
 * 传输不变式与上传侧一致：仅 HTTPS、无 URL 凭据、拒绝重定向、超时与大小上限
 * （总超时通过 abort 信号销毁底层请求，覆盖响应头之前的阶段）。不做下载域名
 * 允许列表，也不做 DNS 私网解析防护：服务端返回什么链接就按原样下载，与自建/
 * 内网部署的服务端保持兼容；投递前仍有 magic bytes 校验兜底。
 * 缓存不做时间过期清理，仅在目录大小达到阈值时按 mtime 从旧到新淘汰；
 * 正在下载或投递中的文件通过引用计数保护，清理永不删除使用中的文件。
 */
export class PreviewDownloadService {
  private readonly inFlight = new Map<string, Promise<CachedPreviewMedia>>();
  private readonly inUse = new Map<string, number>();
  private cleanupChain: Promise<void> = Promise.resolve();
  private startup: Promise<void> | undefined;

  constructor(
    private readonly rootDirectory: string,
    private readonly fetcher: PreviewFetcher = httpsGetPreview
  ) {}

  async initialize(): Promise<void> {
    this.startup ??= this.startupSweep();
    try {
      await this.startup;
    } catch (error) {
      this.startup = undefined;
      throw error;
    }
  }

  /**
   * 确保预览媒体以本地缓存文件可用，并在 `use` 执行期间把文件标记为使用中
   * （含失败路径），保证并发清理不会删除正在投递的文件。
   */
  async withCachedPreview<T>(
    rawUrl: string,
    use: (file: CachedPreviewMedia) => Promise<T>
  ): Promise<T> {
    const url = assertPreviewUrl(rawUrl);
    const key = createHash("sha256").update(url.toString()).digest("hex");
    this.acquire(key);
    try {
      return await use(await this.ensureCachedFile(url, key));
    } finally {
      this.release(key);
    }
  }

  private async ensureCachedFile(url: URL, key: string): Promise<CachedPreviewMedia> {
    const cached = await this.findCached(key);
    if (cached) return cached;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const download = this.download(url, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, download);
    return download;
  }

  private async findCached(key: string): Promise<CachedPreviewMedia | undefined> {
    for (const extension of Object.keys(PREVIEW_EXTENSION_CONTENT_TYPES)) {
      const filePath = path.join(this.rootDirectory, `${key}${extension}`);
      // lstat：符号链接不算缓存命中，防止目录里残留的链接把任意文件当作预览投递。
      const details = await lstat(filePath).catch(() => undefined);
      if (details?.isFile()) {
        return {
          filePath,
          contentType: PREVIEW_EXTENSION_CONTENT_TYPES[extension]!,
          bytes: details.size
        };
      }
    }
    return undefined;
  }

  private async download(url: URL, key: string): Promise<CachedPreviewMedia> {
    await this.initialize();
    const tmpPath = path.join(this.rootDirectory, `${key}.tmp-${randomUUID()}`);
    let saved: { contentType: string; extension: string; bytes: number };
    try {
      saved = await this.downloadToFile(url, tmpPath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const filePath = path.join(this.rootDirectory, `${key}${saved.extension}`);
    // POSIX rename 可覆盖同名文件；Windows 不承诺，先尽力移除旧目标。
    await rm(filePath, { force: true }).catch(() => undefined);
    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw cacheWriteError(error);
    }
    await this.scheduleCleanup();
    return { filePath, contentType: saved.contentType, bytes: saved.bytes };
  }

  private async downloadToFile(
    url: URL,
    tmpPath: string
  ): Promise<{ contentType: string; extension: string; bytes: number }> {
    let timer: NodeJS.Timeout | undefined;
    let response: PreviewFetchResponse | undefined;
    let iterator: AsyncIterator<Buffer> | undefined;
    const abortController = new AbortController();
    // 整体 60s 截止：超时先主动断开连接（响应头之前靠 abort 销毁请求，之后靠 close
    // 断开响应），再让等待方立即失败，防止悬挂请求占住工具调用或泄漏连接。
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = downloadError("PREVIEW_DOWNLOAD_TIMEOUT", true, "预览下载超时。");
        response?.close(error);
        abortController.abort(error);
        reject(error);
      }, PREVIEW_DOWNLOAD_TIMEOUT_MS);
    });
    void deadline.catch(() => undefined);

    let fileHandle: FileHandle | undefined;
    let bytes = 0;
    try {
      const file = await withCacheFsError(() =>
        open(tmpPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
      );
      fileHandle = file;
      response = await Promise.race([this.fetcher(url, abortController.signal), deadline]);
      const status = response.status;
      if (status >= 300 && status < 400) {
        throw downloadError("PREVIEW_DOWNLOAD_REDIRECTED", false, `预览下载被重定向（status ${status}），已拒绝。`);
      }
      if (status < 200 || status >= 300) {
        throw downloadError(
          "PREVIEW_DOWNLOAD_FAILED",
          status >= 500 || status === 408 || status === 429,
          `预览下载失败（status ${status}）。`
        );
      }
      const declaredBytes = Number(response.contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PREVIEW_DOWNLOAD_BYTES) {
        throw downloadError("PREVIEW_DOWNLOAD_TOO_LARGE", false, "预览下载内容超过大小上限。");
      }

      const writeCounted = async (data: Buffer): Promise<void> => {
        if (bytes + data.length > MAX_PREVIEW_DOWNLOAD_BYTES) {
          throw downloadError("PREVIEW_DOWNLOAD_TOO_LARGE", false, "预览下载内容超过大小上限。");
        }
        const { bytesWritten } = await withCacheFsError(() => file.write(data));
        if (bytesWritten !== data.length) {
          throw cacheWriteError(new Error(`短写 ${bytesWritten}/${data.length} 字节`));
        }
        bytes += data.length;
      };

      iterator = response.body[Symbol.asyncIterator]();
      let detected: ReturnType<typeof detectMedia> | undefined;
      let head: Buffer = Buffer.alloc(0);
      while (true) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next.done) break;
        const chunk = next.value;
        if (detected !== undefined) {
          await writeCounted(chunk);
          continue;
        }
        head = head.length === 0 ? chunk : Buffer.concat([head, chunk]);
        if (head.length < 12) continue;
        detected = detectPreviewMedia(head);
        await writeCounted(head);
      }
      if (detected === undefined) {
        throw downloadError("PREVIEW_DOWNLOAD_INVALID_MEDIA", false, "预览下载内容不足，无法识别图片格式。");
      }

      await withCacheFsError(() => file.sync());
      await withCacheFsError(() => file.close());
      return { contentType: detected.contentType, extension: detected.extension, bytes };
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      throw normalizeDownloadError(error);
    } finally {
      clearTimeout(timer);
      if (iterator?.return) await iterator.return().catch(() => undefined);
      response?.close();
    }
  }

  private async startupSweep(): Promise<void> {
    // 目录创建/权限修复失败是本地环境问题，必须与其他缓存写入失败一样收敛为
    // PREVIEW_CACHE_WRITE_FAILED，不能把裸 fs 错误泄给调用方。
    await withCacheFsError(() =>
      ensurePrivateDirectory(this.rootDirectory, PREVIEW_CACHE_DIRECTORY_POLICY)
    );
    // 目录存在但不可读（如仅写执行的异配置）时清扫跳过：真写不进去会在下载的
    // open() 以 PREVIEW_CACHE_WRITE_FAILED 失败，这里与 cleanupOnce 的容错一致。
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      // 单 gateway 进程刚启动时不存在使用中的文件：tmp 遗留、符号链接与不符合
      // 命名规则的文件全部清走（rm 只解除链接本身，不会跟随删除目标）。
      if (
        entry.isSymbolicLink() ||
        (entry.isFile() && (isTmpName(entry.name) || !CACHE_FILE_PATTERN.test(entry.name)))
      ) {
        await rm(path.join(this.rootDirectory, entry.name), { force: true }).catch(() => undefined);
      }
    }
    await this.scheduleCleanup();
  }

  private scheduleCleanup(): Promise<void> {
    const next = this.cleanupChain.then(() => this.cleanupOnce()).then(() => undefined, () => undefined);
    this.cleanupChain = next;
    return next;
  }

  private async cleanupOnce(): Promise<void> {
    const entries = await readdir(this.rootDirectory, { withFileTypes: true }).catch(() => []);
    const staleCutoff = Date.now() - PREVIEW_DOWNLOAD_TIMEOUT_MS;
    const cached: Array<{ name: string; filePath: string; size: number; mtimeMs: number }> = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.rootDirectory, entry.name);
      if (isTmpName(entry.name)) {
        // 下载不可能超过超时时长仍存活；超过时长的 tmp 是崩溃残留（不属于时间过期清理）。
        const details = await stat(filePath).catch(() => undefined);
        if (details && details.mtimeMs < staleCutoff && this.inUseCount(entry.name.slice(0, 64)) === 0) {
          await rm(filePath, { force: true }).catch(() => undefined);
        }
        continue;
      }
      if (!CACHE_FILE_PATTERN.test(entry.name)) continue;
      const details = await stat(filePath).catch(() => undefined);
      if (!details?.isFile()) continue;
      cached.push({ name: entry.name, filePath, size: details.size, mtimeMs: details.mtimeMs });
      totalBytes += details.size;
    }

    // 阈值只触发清理，不拒绝新文件保存；按 mtime 从旧到新删到阈值以下即停，
    // 删尽非使用中文件仍不够时视为已尽力，留待下一轮。
    if (totalBytes < PREVIEW_CACHE_CLEANUP_THRESHOLD_BYTES) return;
    cached.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of cached) {
      if (totalBytes < PREVIEW_CACHE_CLEANUP_THRESHOLD_BYTES) break;
      if (this.inUseCount(entry.name.slice(0, 64)) > 0) continue;
      try {
        await unlink(entry.filePath);
        totalBytes -= entry.size;
      } catch {
        // Windows EPERM/EBUSY 等失败交给下一轮清理重试。
      }
    }
  }

  private acquire(key: string): void {
    this.inUse.set(key, (this.inUse.get(key) ?? 0) + 1);
  }

  private release(key: string): void {
    const count = (this.inUse.get(key) ?? 0) - 1;
    if (count > 0) this.inUse.set(key, count);
    else this.inUse.delete(key);
  }

  private inUseCount(key: string): number {
    return this.inUse.get(key) ?? 0;
  }
}

function isTmpName(name: string): boolean {
  return name.includes(".tmp-");
}

function detectPreviewMedia(buffer: Buffer): ReturnType<typeof detectMedia> {
  try {
    const detected = detectMedia(buffer);
    if (detected.kind !== "image" || !PREVIEW_IMAGE_FORMATS.has(detected.format)) {
      throw unsupportedPreviewMedia();
    }
    return detected;
  } catch {
    throw unsupportedPreviewMedia();
  }
}

function unsupportedPreviewMedia(): PluginError {
  return downloadError("PREVIEW_DOWNLOAD_INVALID_MEDIA", false, "预览下载内容不是支持的图片格式（JPEG/PNG/WebP）。");
}

function assertPreviewUrl(rawUrl: string): URL {
  if (rawUrl.length > 8192) throw previewUrlRejected();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw previewUrlRejected();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    throw previewUrlRejected();
  }
  return url;
}

function previewUrlRejected(): PluginError {
  return downloadError("PREVIEW_URL_REJECTED", false, "预览下载地址不符合 Quick Image 传输策略。");
}

function downloadError(code: string, retryable: boolean, message: string): PluginError {
  return new PluginError(code, message, {
    retryable,
    suggested_action: "改为直接发送原图链接文本，不要重试预览下载。"
  });
}

function normalizeDownloadError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  return downloadError("PREVIEW_DOWNLOAD_NETWORK_ERROR", true, "预览下载网络错误。");
}

/**
 * 本地缓存写入失败（目录不可写、磁盘满、短写、rename 失败等）是环境问题，
 * 必须与网络错误区分开：不可重试，也不能报成"目标解析到被阻止的地址"。
 */
function cacheWriteError(error: unknown): PluginError {
  if (error instanceof PluginError) return error;
  const code = (error as { code?: string } | null)?.code;
  const reason = typeof code === "string" && code !== ""
    ? code
    : error instanceof Error && error.message !== ""
      ? error.message
      : "unknown";
  return new PluginError("PREVIEW_CACHE_WRITE_FAILED", `写入本地预览缓存失败（${reason}）。`, {
    retryable: false,
    suggested_action: "检查预览缓存目录权限与磁盘状态；或改为直接发送原图链接文本。"
  });
}

async function withCacheFsError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw cacheWriteError(error);
  }
}

function httpsGetPreview(url: URL, signal: AbortSignal): Promise<PreviewFetchResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        timeout: PREVIEW_DOWNLOAD_TIMEOUT_MS,
        maxHeaderSize: 64 * 1024
      },
      (response) => {
        const contentLengthHeader = response.headers["content-length"];
        resolve({
          status: response.statusCode ?? 0,
          contentLength: Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader,
          body: wrapResponseBody(response),
          close: (error?: Error) => request.destroy(error)
        });
      }
    );
    // timeout 选项绑定的是 socket 空闲超时，慢滴流源可以不断重置它；abort 在
    // 响应头到达前也能无条件销毁请求，避免连接被无限占用。
    signal.addEventListener("abort", () => request.destroy(signal.reason));
    request.once("timeout", () => request.destroy(downloadError("PREVIEW_DOWNLOAD_TIMEOUT", true, "预览下载超时。")));
    request.once("error", (error) => {
      reject(error instanceof PluginError ? error : normalizeDownloadError(error));
    });
    request.end();
  });
}

async function* wrapResponseBody(response: IncomingMessage): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of response) yield chunk as Buffer;
  } catch (error) {
    throw error instanceof PluginError ? error : normalizeDownloadError(error);
  }
  // 连接中途断开时流可能“正常结束”，用 complete 区分完整报文与截断下载。
  if (!response.complete) throw normalizeDownloadError(new Error("preview download truncated"));
}
