import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PREVIEW_DOWNLOAD_BYTES,
  PREVIEW_CACHE_CLEANUP_THRESHOLD_BYTES,
  PREVIEW_DOWNLOAD_TIMEOUT_MS
} from "../src/constants.js";
import {
  PreviewDownloadService,
  type PreviewFetchResponse,
  type PreviewFetcher
} from "../src/services/download-preview-media.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PreviewDownloadService", () => {
  it("downloads a preview into the private cache and marks it in use", async () => {
    const { service, cacheDirectory, fetcher } = await createService();
    const body = mediaBuffer("jpeg");
    const seen: string[] = [];

    const result = await service.withCachedPreview("https://media.quickimage.ai/preview/key", async (file) => {
      seen.push(file.filePath);
      expect(file.contentType).toBe("image/jpeg");
      expect(file.bytes).toBe(body.length);
      return "sent";
    });

    expect(result).toBe("sent");
    expect(fetcher).toHaveBeenCalledOnce();
    const key = cacheKey("https://media.quickimage.ai/preview/key");
    const filePath = path.join(cacheDirectory, `${key}.jpg`);
    expect(seen).toEqual([filePath]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(body.toString("utf8"));
    const directoryDetails = await stat(cacheDirectory);
    expect(directoryDetails.mode & 0o077).toBe(0);
    const fileDetails = await stat(filePath);
    expect(fileDetails.mode & 0o077).toBe(0);
  });

  it("rejects preview URLs that violate the transport policy", async () => {
    const { service, fetcher } = await createService();
    for (const url of [
      "http://media.quickimage.ai/preview.jpg",
      "https://user:pass@media.quickimage.ai/preview.jpg",
      "not-a-url"
    ]) {
      await expect(service.withCachedPreview(url, async () => "sent")).rejects.toMatchObject({
        code: "PREVIEW_URL_REJECTED"
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails on non-2xx responses with retryable details", async () => {
    const { service } = await createService(mediaBuffer("jpeg"), { status: 404 });
    await expect(service.withCachedPreview("https://media.example.com/a", async () => "sent")).rejects.toMatchObject({
      code: "PREVIEW_DOWNLOAD_FAILED",
      details: { retryable: false }
    });

    const { service: serverErrorService } = await createService(mediaBuffer("jpeg"), { status: 503 });
    await expect(serverErrorService.withCachedPreview("https://media.example.com/a", async () => "sent"))
      .rejects.toMatchObject({ code: "PREVIEW_DOWNLOAD_FAILED", details: { retryable: true } });
  });

  it("rejects redirects without following them", async () => {
    const { service } = await createService(mediaBuffer("jpeg"), { status: 302 });
    await expect(service.withCachedPreview("https://media.example.com/a", async () => "sent")).rejects.toMatchObject({
      code: "PREVIEW_DOWNLOAD_REDIRECTED"
    });
  });

  it("enforces the total download deadline", async () => {
    // fake timers 会替换 setImmediate；保留真实引用用于等待真实 fs/网络前置步骤完成。
    const realSetImmediate = globalThis.setImmediate.bind(globalThis);
    vi.useFakeTimers();
    const close = vi.fn();
    let bodyRequested = false;
    const hangingBody: AsyncIterable<Buffer> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          bodyRequested = true;
          return new Promise<IteratorResult<Buffer>>(() => undefined);
        }
      })
    };
    const fetcher: PreviewFetcher = vi.fn(async () => ({
      status: 200,
      contentLength: undefined,
      body: hangingBody,
      close
    }));
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-preview-test-"));
    temporaryDirectories.push(root);
    const cacheDirectory = path.join(root, "preview-cache");
    const service = new PreviewDownloadService(cacheDirectory, fetcher);

    const pending = service.withCachedPreview("https://media.example.com/slow", async () => "sent");
    // 等待下载进入流式阶段，确保 60s 截止定时器已注册后再推进虚拟时钟。
    while (!bodyRequested) await new Promise<void>((resolve) => realSetImmediate(resolve));
    const assertion = expect(pending).rejects.toMatchObject({ code: "PREVIEW_DOWNLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(PREVIEW_DOWNLOAD_TIMEOUT_MS + 1);
    await assertion;

    expect(close).toHaveBeenCalledWith(expect.objectContaining({ code: "PREVIEW_DOWNLOAD_TIMEOUT" }));
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("aborts the fetcher when the deadline fires before response headers arrive", async () => {
    // fake timers 会替换 setImmediate；保留真实引用用于等待真实 fs 前置步骤完成。
    const realSetImmediate = globalThis.setImmediate.bind(globalThis);
    vi.useFakeTimers();
    let fetchStarted = false;
    let observedSignal: AbortSignal | undefined;
    // 模拟响应头永远不到达、socket 靠滴流保温的源：fetcher 只能通过 abort 信号销毁。
    const fetcher: PreviewFetcher = vi.fn(
      (_url: URL, signal: AbortSignal) => {
        fetchStarted = true;
        observedSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      }
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-preview-test-"));
    temporaryDirectories.push(root);
    const cacheDirectory = path.join(root, "preview-cache");
    const service = new PreviewDownloadService(cacheDirectory, fetcher);

    const pending = service.withCachedPreview("https://media.example.com/never-responds", async () => "sent");
    while (!fetchStarted) await new Promise<void>((resolve) => realSetImmediate(resolve));
    const assertion = expect(pending).rejects.toMatchObject({ code: "PREVIEW_DOWNLOAD_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(PREVIEW_DOWNLOAD_TIMEOUT_MS + 1);
    await assertion;

    expect(observedSignal?.aborted).toBe(true);
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("reports local cache write failures as a distinct non-retryable error", async () => {
    const { service, cacheDirectory } = await createService(mediaBuffer("jpeg"));
    await service.initialize();
    await chmod(cacheDirectory, 0o500);
    try {
      await expect(
        service.withCachedPreview("https://media.example.com/readonly", async () => "sent")
      ).rejects.toMatchObject({
        code: "PREVIEW_CACHE_WRITE_FAILED",
        message: expect.stringContaining("EACCES"),
        details: { retryable: false }
      });
    } finally {
      await chmod(cacheDirectory, 0o700);
    }
  });

  it("reports cache directory creation failures as cache write errors, not raw fs errors", async () => {
    const { service, root, fetcher } = await createService(mediaBuffer("jpeg"));
    await chmod(root, 0o500);
    try {
      await expect(
        service.withCachedPreview("https://media.example.com/blocked-parent", async () => "sent")
      ).rejects.toMatchObject({
        code: "PREVIEW_CACHE_WRITE_FAILED",
        message: expect.stringContaining("EACCES"),
        details: { retryable: false }
      });
    } finally {
      await chmod(root, 0o700);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a symlinked cache directory as insecure with a preview-specific error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-preview-test-"));
    temporaryDirectories.push(root);
    const target = path.join(root, "elsewhere");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await symlink(target, path.join(root, "preview-cache"));
    const fetcher: PreviewFetcher = vi.fn(async () => responseOf(mediaBuffer("jpeg")));
    const service = new PreviewDownloadService(path.join(root, "preview-cache"), fetcher);

    await expect(
      service.withCachedPreview("https://media.example.com/linked-dir", async () => "sent")
    ).rejects.toMatchObject({ code: "INSECURE_PREVIEW_CACHE_DIRECTORY" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("still downloads when the cache directory is writable but unreadable", async () => {
    const { service, cacheDirectory } = await createService(mediaBuffer("jpeg"));
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    // 0300 = 仅写执行：readdir 失败但 open/rename 可用，清扫与淘汰跳过、下载照常。
    await chmod(cacheDirectory, 0o300);
    try {
      const bytes = await service.withCachedPreview(
        "https://media.example.com/write-only-dir",
        async (file) => file.bytes
      );
      expect(bytes).toBe(mediaBuffer("jpeg").length);
    } finally {
      await chmod(cacheDirectory, 0o700);
    }
  });

  it("rejects bodies exceeding the size cap before and during streaming", async () => {
    const oversized = String(MAX_PREVIEW_DOWNLOAD_BYTES + 1);
    const { service: declaredService, fetcher: declaredFetcher } = await createService(mediaBuffer("jpeg"), {
      contentLength: oversized
    });
    await expect(declaredService.withCachedPreview("https://media.example.com/big", async () => "sent"))
      .rejects.toMatchObject({ code: "PREVIEW_DOWNLOAD_TOO_LARGE" });
    expect(declaredFetcher).toHaveBeenCalledOnce();

    const chunk = Buffer.alloc(30 * 1024 * 1024);
    chunk.set(mediaBuffer("jpeg", 64));
    const streamingFetcher: PreviewFetcher = vi.fn(async () => ({
      status: 200,
      contentLength: undefined,
      body: (async function* () {
        yield chunk;
        yield chunk;
      })(),
      close: vi.fn()
    }));
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-preview-test-"));
    temporaryDirectories.push(root);
    const streamingService = new PreviewDownloadService(path.join(root, "preview-cache"), streamingFetcher);
    await expect(streamingService.withCachedPreview("https://media.example.com/chunked", async () => "sent"))
      .rejects.toMatchObject({ code: "PREVIEW_DOWNLOAD_TOO_LARGE" });
  });

  it("validates magic bytes and only accepts jpeg, png and webp images", async () => {
    for (const [label, body] of [
      ["gif", mediaBuffer("gif")],
      ["mp4", mediaBuffer("mp4")],
      ["short-body", Buffer.from([0xff, 0xd8, 0xff])]
    ] as const) {
      const { service } = await createService(body);
      await expect(
        service.withCachedPreview(`https://media.example.com/${label}`, async () => "sent")
      ).rejects.toMatchObject({ code: "PREVIEW_DOWNLOAD_INVALID_MEDIA" });
    }
  });

  it("reuses a cached file for the same URL without a network request", async () => {
    const { service, cacheDirectory, fetcher } = await createService(mediaBuffer("png"));
    const url = "https://media.example.com/stable";

    const first = await service.withCachedPreview(url, async (file) => file.filePath);
    const second = await service.withCachedPreview(url, async (file) => file.filePath);

    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(first).toBe(path.join(cacheDirectory, `${cacheKey(url)}.png`));
  });

  it("deduplicates concurrent downloads of the same URL", async () => {
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetcher: PreviewFetcher = vi.fn(async () => {
      await fetchGate;
      return responseOf(mediaBuffer("webp"));
    });
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-preview-test-"));
    temporaryDirectories.push(root);
    const service = new PreviewDownloadService(path.join(root, "preview-cache"), fetcher);

    const first = service.withCachedPreview("https://media.example.com/same", async () => "first");
    const second = service.withCachedPreview("https://media.example.com/same", async () => "second");
    await flush();
    releaseFetch();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not reuse unfinished temporary files", async () => {
    const { service, cacheDirectory, fetcher } = await createService();
    const url = "https://media.example.com/resumed";
    const key = cacheKey(url);
    await mkdir(cacheDirectory, { recursive: true });
    await open(path.join(cacheDirectory, `${key}.tmp-legacy`), "w", 0o600);

    await service.withCachedPreview(url, async () => "sent");

    expect(fetcher).toHaveBeenCalledOnce();
    await expect(stat(path.join(cacheDirectory, `${key}.jpg`))).resolves.toBeDefined();
  });

  it("cleans up to below the threshold oldest-first when the cache grows too large", async () => {
    const { service, cacheDirectory } = await createService();
    const megabytes = 1024 * 1024;
    expect(3 * 75 * megabytes).toBeGreaterThanOrEqual(PREVIEW_CACHE_CLEANUP_THRESHOLD_BYTES);
    const oldA = await createCacheFile(cacheDirectory, "a", 75 * megabytes, new Date("2026-01-01T00:00:00Z"));
    const oldB = await createCacheFile(cacheDirectory, "b", 75 * megabytes, new Date("2026-01-02T00:00:00Z"));
    const newest = await createCacheFile(cacheDirectory, "c", 75 * megabytes, new Date("2026-01-03T00:00:00Z"));

    await service.initialize();

    await expect(stat(oldA)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(oldB)).resolves.toBeDefined();
    await expect(stat(newest)).resolves.toBeDefined();
  });

  it("saves new files first and only triggers cleanup afterwards", async () => {
    const { service, cacheDirectory } = await createService(mediaBuffer("jpeg"));
    await service.initialize();
    const megabytes = 1024 * 1024;
    const oldA = await createCacheFile(cacheDirectory, "a", 75 * megabytes, new Date("2026-01-01T00:00:00Z"));
    const oldB = await createCacheFile(cacheDirectory, "b", 75 * megabytes, new Date("2026-01-02T00:00:00Z"));
    const newest = await createCacheFile(cacheDirectory, "c", 75 * megabytes, new Date("2026-01-03T00:00:00Z"));

    const result = await service.withCachedPreview("https://media.example.com/fresh", async (file) => file.bytes);

    expect(result).toBe(mediaBuffer("jpeg").length);
    const freshPath = path.join(cacheDirectory, `${cacheKey("https://media.example.com/fresh")}.jpg`);
    await expect(stat(freshPath)).resolves.toBeDefined();
    await expect(stat(oldA)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(oldB)).resolves.toBeDefined();
    await expect(stat(newest)).resolves.toBeDefined();
  });

  it("never deletes files that are in use while delivering", async () => {
    const { service, cacheDirectory } = await createService(mediaBuffer("jpeg"));
    const megabytes = 1024 * 1024;
    const inUseUrl = "https://media.example.com/in-use";
    const inUseFile = await createCacheFile(
      cacheDirectory,
      cacheKey(inUseUrl),
      75 * megabytes,
      new Date("2026-01-01T00:00:00Z")
    );
    const oldB = await createCacheFile(cacheDirectory, "b", 75 * megabytes, new Date("2026-01-02T00:00:00Z"));
    const newest = await createCacheFile(cacheDirectory, "c", 75 * megabytes, new Date("2026-01-03T00:00:00Z"));

    let releaseUse!: () => void;
    const useGate = new Promise<void>((resolve) => {
      releaseUse = resolve;
    });
    const delivering = service.withCachedPreview(inUseUrl, async () => {
      await useGate;
      return "delivered";
    });
    await flush();

    await service.withCachedPreview("https://media.example.com/other", async () => "sent");
    releaseUse();
    await expect(delivering).resolves.toBe("delivered");

    await expect(stat(inUseFile)).resolves.toBeDefined();
    await expect(stat(oldB)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(newest)).resolves.toBeDefined();
  });

  it("sweeps temporary leftovers and unrecognized files at startup", async () => {
    const { service, cacheDirectory } = await createService();
    const keepFile = await createCacheFile(cacheDirectory, cacheKey("https://media.example.com/keep"), 64, new Date());
    const tmpLeftover = path.join(cacheDirectory, `${"d".repeat(64)}.tmp-legacy`);
    await open(tmpLeftover, "w", 0o600);
    const unrecognized = path.join(cacheDirectory, "readme.txt");
    await open(unrecognized, "w", 0o600);

    await service.initialize();

    await expect(stat(keepFile)).resolves.toBeDefined();
    await expect(stat(tmpLeftover)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(unrecognized)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not serve symlinked cache entries", async () => {
    const { service, cacheDirectory, fetcher } = await createService(mediaBuffer("png"));
    const url = "https://media.example.com/linked";
    const key = cacheKey(url);
    const target = path.join(path.dirname(cacheDirectory), "outside.bin");
    const handle = await open(target, "w", 0o600);
    await handle.close();
    await mkdir(cacheDirectory, { recursive: true });
    await symlink(target, path.join(cacheDirectory, `${key}.jpg`));

    const file = await service.withCachedPreview(url, (cached) => Promise.resolve(cached));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(file.contentType).toBe("image/png");
    await expect(stat(path.join(cacheDirectory, `${key}.png`))).resolves.toBeDefined();
  });

  it("sweeps symlinks from the cache directory at startup", async () => {
    const { service, cacheDirectory } = await createService();
    const target = path.join(path.dirname(cacheDirectory), "outside.bin");
    const handle = await open(target, "w", 0o600);
    await handle.close();
    await mkdir(cacheDirectory, { recursive: true });
    const link = path.join(cacheDirectory, `${"e".repeat(64)}.webp`);
    await symlink(target, link);

    await service.initialize();

    await expect(stat(link)).rejects.toMatchObject({ code: "ENOENT" });
    // rm 只解除链接本身，不跟随删除目标文件。
    await expect(stat(target)).resolves.toBeDefined();
  });

  it("tolerates unlink failures during cleanup and retries on the next round", async () => {
    const { service, cacheDirectory } = await createService();
    const megabytes = 1024 * 1024;
    const oldA = await createCacheFile(cacheDirectory, "a", 75 * megabytes, new Date("2026-01-01T00:00:00Z"));
    const oldB = await createCacheFile(cacheDirectory, "b", 75 * megabytes, new Date("2026-01-02T00:00:00Z"));
    const newest = await createCacheFile(cacheDirectory, "c", 75 * megabytes, new Date("2026-01-03T00:00:00Z"));

    await chmod(cacheDirectory, 0o500);
    try {
      await expect(service.initialize()).resolves.toBeUndefined();
      await expect(stat(oldA)).resolves.toBeDefined();
      await expect(stat(oldB)).resolves.toBeDefined();
    } finally {
      await chmod(cacheDirectory, 0o700);
    }

    await service.withCachedPreview("https://media.example.com/next-round", async () => "sent");

    await expect(stat(oldA)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(oldB)).resolves.toBeDefined();
    await expect(stat(newest)).resolves.toBeDefined();
  });
});

function mediaBuffer(format: "jpeg" | "png" | "webp" | "gif" | "mp4", size = 64): Buffer {
  const head = format === "jpeg"
    ? Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    : format === "png"
      ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : format === "webp"
        ? Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])
        : format === "gif"
          ? Buffer.from("GIF89a")
          : Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(4)]);
  return Buffer.concat([head, Buffer.alloc(Math.max(size - head.length, 0) + 8, 0x61)]);
}

function responseOf(body: Buffer, options: { status?: number; contentLength?: string } = {}): PreviewFetchResponse {
  return {
    status: options.status ?? 200,
    contentLength: options.contentLength ?? String(body.length),
    body: (async function* () {
      yield body;
    })(),
    close: vi.fn()
  };
}

async function createService(
  body: Buffer = mediaBuffer("jpeg"),
  options: { status?: number; contentLength?: string } = {}
): Promise<{
  service: PreviewDownloadService;
  cacheDirectory: string;
  root: string;
  fetcher: ReturnType<typeof vi.fn>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-preview-test-"));
  temporaryDirectories.push(root);
  const cacheDirectory = path.join(root, "preview-cache");
  const fetcher = vi.fn(async () => responseOf(body, options));
  return { service: new PreviewDownloadService(cacheDirectory, fetcher), cacheDirectory, root, fetcher };
}

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

async function createCacheFile(
  cacheDirectory: string,
  keyOrName: string,
  sizeBytes: number,
  mtime: Date
): Promise<string> {
  const name = keyOrName.length === 64 ? `${keyOrName}.jpg` : `${keyOrName}${"0".repeat(64 - keyOrName.length)}.jpg`;
  await mkdir(cacheDirectory, { recursive: true });
  const filePath = path.join(cacheDirectory, name);
  const handle = await open(filePath, "w", 0o600);
  await handle.truncate(sizeBytes);
  await handle.close();
  await utimes(filePath, mtime, mtime);
  return filePath;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
