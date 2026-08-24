import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandleStore } from "../src/store/handle-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("HandleStore", () => {
  it("restores a claimed stage after a retryable failure", async () => {
    const fixture = await createFixture("unused");
    const stateDirectory = path.join(fixture.root, "state");
    const store = new HandleStore(stateDirectory);
    await store.initialize();
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    const handle = await store.createStage(Buffer.from("staged"), {
      record_type: "staged",
      content_type: "image/png",
      size: 6,
      checksum: "sha256:test",
      expires_at: new Date(Date.now() + 60_000).toISOString()
    });

    await expect(
      store.withStage(handle, async () => {
        throw new Error("network unavailable");
      })
    ).rejects.toThrow("network unavailable");
    await expect(store.withStage(handle, async (record) => record.size)).resolves.toBe(6);
  });

  it("preserves unexpired inspection records across store restarts", async () => {
    const fixture = await createFixture("inspected");
    const stateDirectory = path.join(fixture.root, "state");
    const firstStore = new HandleStore(stateDirectory);
    await firstStore.initialize();
    const handle = await firstStore.createInspection({
      record_type: "inspected",
      source_path: fixture.file,
      filename: "attachment.png",
      kind: "image",
      format: "png",
      content_type: "image/png",
      size: 9,
      source_checksum: "sha256:test",
      file_identity: testFileIdentity(9),
      metadata: { width: 32, height: 32 },
      expires_at: new Date(Date.now() + 60_000).toISOString()
    });

    const restartedStore = new HandleStore(stateDirectory);
    await restartedStore.initialize();

    await expect(restartedStore.withInspection(handle, async (record) => record.filename))
      .resolves.toBe("attachment.png");
  });

  it("restores and rejects handles used from another host session scope", async () => {
    const fixture = await createFixture("inspected");
    const store = new HandleStore(path.join(fixture.root, "state"));
    await store.initialize();
    const scopeDigest = "a".repeat(64);
    const handle = await store.createInspection({
      record_type: "inspected",
      scope_digest: scopeDigest,
      source_path: fixture.file,
      filename: "attachment.png",
      kind: "image",
      format: "png",
      content_type: "image/png",
      size: 9,
      source_checksum: "sha256:test",
      file_identity: testFileIdentity(9),
      metadata: { width: 32, height: 32 },
      expires_at: new Date(Date.now() + 60_000).toISOString()
    });

    await expect(store.withInspection(handle, async () => undefined, "b".repeat(64))).rejects.toMatchObject({
      code: "ATTACHMENT_HANDLE_NOT_FOUND"
    });
    await expect(store.withInspection(handle, async (record) => record.filename, scopeDigest))
      .resolves.toBe("attachment.png");
  });

  it("removes expired inspection and stage records with staged files", async () => {
    const fixture = await createFixture("expired");
    const store = new HandleStore(path.join(fixture.root, "state"));
    await store.initialize();
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    const attachmentHandle = await store.createInspection({
      record_type: "inspected",
      source_path: fixture.file,
      filename: "attachment.png",
      kind: "image",
      format: "png",
      content_type: "image/png",
      size: 7,
      source_checksum: "sha256:test",
      file_identity: testFileIdentity(7),
      metadata: { width: 32, height: 32 },
      expires_at: expiredAt
    });
    const stagedHandle = await store.createStage(Buffer.from("staged"), {
      record_type: "staged",
      content_type: "image/png",
      size: 6,
      checksum: "sha256:test",
      expires_at: expiredAt
    });

    await store.cleanupExpired();

    await expect(store.withInspection(attachmentHandle, async () => undefined)).rejects.toMatchObject({
      code: "ATTACHMENT_HANDLE_NOT_FOUND"
    });
    await expect(store.withStage(stagedHandle, async () => undefined)).rejects.toMatchObject({
      code: "STAGED_HANDLE_NOT_FOUND"
    });
  });

  it("does not clean a fresh lease that crosses its expiry while in use", async () => {
    const fixture = await createFixture("leased");
    const store = new HandleStore(path.join(fixture.root, "state"));
    await store.initialize();
    const expiresAt = new Date(Date.now() + 60_000);
    const handle = await store.createStage(Buffer.from("staged"), {
      record_type: "staged",
      content_type: "image/png",
      size: 6,
      checksum: "sha256:test",
      expires_at: expiresAt.toISOString()
    });

    await expect(store.withStage(handle, async (record, stagedPath) => {
      await store.cleanupExpired(new Date(expiresAt.getTime() + 1));
      expect(await stat(stagedPath)).toBeDefined();
      return record.size;
    })).resolves.toBe(6);
  });

  it("rejects symlinked private state subdirectories", async () => {
    const fixture = await createFixture("attachment-data");
    const root = path.join(fixture.root, "state");
    const redirected = path.join(fixture.root, "redirected");
    await mkdir(root, { mode: 0o700 });
    await mkdir(redirected, { mode: 0o700 });
    await symlink(redirected, path.join(root, "staged-records"));

    await expect(new HandleStore(root).initialize()).rejects.toMatchObject({ code: "INSECURE_STATE_DIRECTORY" });
  });

  it("removes legacy attachment registration and captured byte state", async () => {
    const fixture = await createFixture("attachment-data");
    const root = path.join(fixture.root, "state");
    const legacyDirectory = path.join(root, "handles");
    const capturedRecords = path.join(root, "captured-records");
    const capturedFiles = path.join(root, "captured-files");
    await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
    await mkdir(capturedRecords, { recursive: true, mode: 0o700 });
    await mkdir(capturedFiles, { recursive: true, mode: 0o700 });
    await writeFile(path.join(legacyDirectory, "legacy.json"), JSON.stringify({ source_path: fixture.file }));
    await writeFile(path.join(capturedRecords, "legacy.json"), "{}\n");
    await writeFile(path.join(capturedFiles, "legacy.bin"), "captured");

    await new HandleStore(root).initialize();

    await expect(stat(legacyDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(capturedRecords)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(capturedFiles)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(content: string): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-plugin-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "input"));
  const file = path.join(root, "input", "attachment.bin");
  await writeFile(file, content, { mode: 0o600 });
  return { root, file };
}

function testFileIdentity(size: number) {
  return {
    device: "1",
    inode: "2",
    size,
    modified_at_ns: "3",
    changed_at_ns: "4"
  };
}
