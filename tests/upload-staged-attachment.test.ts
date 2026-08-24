import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadTargetPolicy } from "../src/security/upload-target.js";
import { UploadStagedAttachmentService } from "../src/services/upload-staged-attachment.js";
import { HandleStore } from "../src/store/handle-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("UploadStagedAttachmentService", () => {
  it("uploads exactly the staged bytes and consumes the handle after success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-upload-test-"));
    temporaryDirectories.push(root);
    const store = new HandleStore(path.join(root, "state"));
    await store.initialize();
    const buffer = Buffer.from("exact staged bytes");
    const stagedHandle = await store.createStage(buffer, {
      record_type: "staged",
      content_type: "image/png",
      size: buffer.length,
      checksum: `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
      expires_at: new Date(Date.now() + 60_000).toISOString()
    });
    const lookup = (() => undefined) as unknown as LookupFunction;
    const policy: UploadTargetPolicy = { assertUrl: (value) => new URL(value), lookup };
    const uploader = vi.fn(async (_url, headers: Record<string, string>, body: Buffer) => {
      expect(headers["content-length"]).toBe(String(buffer.length));
      expect(body.equals(buffer)).toBe(true);
    });
    const service = new UploadStagedAttachmentService(store, policy, uploader);
    const directUpload = {
      asset_id: "asset_test_123",
      upload_url: "https://uploads.quickimage.ai/object?signature=redacted",
      headers: { "content-type": "image/png" },
      expires_at: new Date(Date.now() + 60_000).toISOString()
    };

    await expect(service.execute(stagedHandle, directUpload)).resolves.toEqual({ asset_id: "asset_test_123" });
    expect(uploader).toHaveBeenCalledOnce();
    await expect(service.execute(stagedHandle, directUpload)).rejects.toMatchObject({
      code: "STAGED_HANDLE_NOT_FOUND"
    });
  });
});
