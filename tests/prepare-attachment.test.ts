import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from "../src/constants.js";
import { InspectAttachmentService } from "../src/services/inspect-attachment.js";
import { PrepareAttachmentService } from "../src/services/prepare-attachment.js";
import { HandleStore } from "../src/store/handle-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("InspectAttachmentService and PrepareAttachmentService", () => {
  it("records only a lightweight reference, then normalizes an oversized-edge image after confirmation", async () => {
    const root = await createTemporaryDirectory();
    const filePath = path.join(root, "portrait.png");
    const image = await sharp({
      create: { width: 4000, height: 3200, channels: 3, background: { r: 24, g: 120, b: 80 } }
    }).png().toBuffer();
    await writeFile(filePath, image, { mode: 0o600 });

    const store = await createStore(root);
    const inspected = await new InspectAttachmentService(store).execute(filePath);

    expect(inspected).toMatchObject({
      kind: "image",
      content_type: "image/png",
      byte_size: image.length,
      metadata: { width: 4000, height: 3200 }
    });
    expect(inspected.attachment_handle).toMatch(/^qia_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(inspected)).not.toContain(root);
    expect(await readdir(path.join(root, "state"))).not.toContain("captured-files");

    const result = await new PrepareAttachmentService(store).execute(inspected.attachment_handle);
    expect(result.create_direct_upload_args.kind).toBe("image");
    expect(result.create_direct_upload_args.content_type).toBe("image/png");
    expect(result.create_direct_upload_args.byte_size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(result.create_direct_upload_args.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.create_direct_upload_args.upload_checksum).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Math.max(
      result.create_direct_upload_args.metadata.width ?? 0,
      result.create_direct_upload_args.metadata.height ?? 0
    )).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(JSON.stringify(result)).not.toContain(root);
    await expect(new PrepareAttachmentService(store).execute(inspected.attachment_handle)).rejects.toMatchObject({
      code: "ATTACHMENT_HANDLE_NOT_FOUND"
    });
  });

  it("rejects relative paths during inspection", async () => {
    const root = await createTemporaryDirectory();
    const store = await createStore(root);

    await expect(new InspectAttachmentService(store).execute("portrait.png")).rejects.toMatchObject({
      code: "ATTACHMENT_PATH_NOT_ABSOLUTE"
    });
  });

  it("inspects an OpenClaw inbound media URI from its managed media store", async () => {
    const root = await createTemporaryDirectory();
    const openClawStateDirectory = path.join(root, "openclaw");
    const inboundDirectory = path.join(openClawStateDirectory, "media", "inbound");
    const fileName = "83eb35fd-76b0-4bc2-8913-566c32c73c93.jpg";
    await mkdir(inboundDirectory, { recursive: true });
    await writeFile(path.join(inboundDirectory, fileName), await createImage("jpeg"));
    const store = await createStore(root);

    const inspected = await new InspectAttachmentService(store, openClawStateDirectory)
      .execute(`media://inbound/${fileName}`);
    const prepared = await new PrepareAttachmentService(store).execute(inspected.attachment_handle);

    expect(prepared.create_direct_upload_args).toMatchObject({ kind: "image", content_type: "image/jpeg" });
    expect(JSON.stringify({ inspected, prepared })).not.toContain(openClawStateDirectory);
  });

  it.each([
    "media://outbound/attachment.jpg",
    "media://inbound/..%2Fattachment.jpg",
    "media://inbound/attachment.jpg?token=secret"
  ])("rejects an unsafe OpenClaw media URI: %s", async (mediaUri) => {
    const root = await createTemporaryDirectory();
    const store = await createStore(root);

    await expect(new InspectAttachmentService(store, path.join(root, "openclaw")).execute(mediaUri))
      .rejects.toMatchObject({ code: "ATTACHMENT_MEDIA_URI_INVALID" });
  });

  it("rejects symbolic links during inspection", async () => {
    const root = await createTemporaryDirectory();
    const targetPath = path.join(root, "portrait.png");
    const symlinkPath = path.join(root, "portrait-link.png");
    await writeFile(targetPath, await createImage("png"));
    await symlink(targetPath, symlinkPath);
    const store = await createStore(root);

    await expect(new InspectAttachmentService(store).execute(symlinkPath)).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_REGULAR_FILE"
    });
  });

  it("rejects a source file changed after quotation and preserves the handle for diagnosis", async () => {
    const root = await createTemporaryDirectory();
    const filePath = path.join(root, "portrait.png");
    await writeFile(filePath, await createImage("png"));
    const store = await createStore(root);
    const inspected = await new InspectAttachmentService(store).execute(filePath);
    await writeFile(filePath, await sharp({
      create: { width: 64, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } }
    }).png().toBuffer());

    await expect(new PrepareAttachmentService(store).execute(inspected.attachment_handle)).rejects.toMatchObject({
      code: "ATTACHMENT_CHANGED",
      details: { field: "attachment_handle" }
    });
    await expect(store.withInspection(inspected.attachment_handle, async (record) => record.filename))
      .resolves.toBe("portrait.png");
  });

  it("reports a deleted source as changed and preserves the inspection handle", async () => {
    const root = await createTemporaryDirectory();
    const filePath = path.join(root, "portrait.png");
    await writeFile(filePath, await createImage("png"));
    const store = await createStore(root);
    const inspected = await new InspectAttachmentService(store).execute(filePath);
    await rm(filePath);

    await expect(new PrepareAttachmentService(store).execute(inspected.attachment_handle)).rejects.toMatchObject({
      code: "ATTACHMENT_CHANGED",
      details: { field: "attachment_handle" }
    });
    await expect(store.withInspection(inspected.attachment_handle, async (record) => record.filename))
      .resolves.toBe("portrait.png");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-prepare-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function createStore(root: string): Promise<HandleStore> {
  const store = new HandleStore(path.join(root, "state"));
  await store.initialize();
  return store;
}

async function createImage(format: "png" | "jpeg"): Promise<Buffer> {
  const pipeline = sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 24, g: 120, b: 80 } }
  });
  return format === "png" ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer();
}
