import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { HANDLE_TTL_MS } from "../constants.js";
import { PluginError } from "../errors.js";
import type { InspectedAttachment, StagedAttachment } from "../types.js";

const STALE_LEASE_MS = 10 * 60 * 1000;

interface Claim<T> {
  record: T;
  originalPath: string;
  leasePath: string;
}

interface RecordAccess<T> {
  prefix: "qia_" | "qis_";
  recordType: "inspected" | "staged";
  recordDirectory: string;
  fileDirectory?: string;
  fileId?: (record: T) => string;
  field: "attachment_handle" | "staged_handle";
  invalidCode: string;
  invalidRecordCode: string;
  missingCode: string;
  expiredCode: string;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createHandle(prefix: "qia_" | "qis_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function assertHandle(handle: string, access: RecordAccess<unknown>): void {
  if (!new RegExp(`^${access.prefix}[A-Za-z0-9_-]{43}$`).test(handle)) {
    throw new PluginError(access.invalidCode, "附件句柄格式无效。", { field: access.field });
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const file = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export class HandleStore {
  private readonly root: string;
  private readonly inspectedRecordsDirectory: string;
  private readonly stagedRecordsDirectory: string;
  private readonly stagedFilesDirectory: string;

  constructor(root: string) {
    this.root = root;
    this.inspectedRecordsDirectory = path.join(root, "inspected-records");
    this.stagedRecordsDirectory = path.join(root, "staged-records");
    this.stagedFilesDirectory = path.join(root, "staged-files");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await Promise.all([
      rm(path.join(this.root, "handles"), { recursive: true, force: true }),
      rm(path.join(this.root, "captured-records"), { recursive: true, force: true }),
      rm(path.join(this.root, "captured-files"), { recursive: true, force: true })
    ]);
    for (const directory of [
      this.inspectedRecordsDirectory,
      this.stagedRecordsDirectory,
      this.stagedFilesDirectory
    ]) {
      await ensurePrivateDirectory(directory);
    }
    await this.cleanupExpired();
  }

  async createInspection(record: Omit<InspectedAttachment, "handle_digest">): Promise<string> {
    const handle = createHandle("qia_");
    const inspectedRecord: InspectedAttachment = {
      ...record,
      handle_digest: tokenDigest(handle)
    };
    await writePrivateJson(path.join(this.inspectedRecordsDirectory, `${inspectedRecord.handle_digest}.json`),
      inspectedRecord);
    return handle;
  }

  async createStage(
    buffer: Buffer,
    record: Omit<StagedAttachment, "handle_digest" | "staged_file_id">
  ): Promise<string> {
    const handle = createHandle("qis_");
    const stagedRecord: StagedAttachment = {
      ...record,
      handle_digest: tokenDigest(handle),
      staged_file_id: randomUUID()
    };
    await this.writeRecord(buffer, stagedRecord, this.stagedRecordsDirectory, this.stagedFilesDirectory,
      stagedRecord.staged_file_id);
    return handle;
  }

  async withInspection<T>(
    handle: string,
    action: (record: InspectedAttachment) => Promise<T>,
    scopeDigest?: string
  ): Promise<T> {
    return this.withRecord(handle, this.inspectedAccess(), (record) => action(record), scopeDigest);
  }

  async withStage<T>(
    handle: string,
    action: (record: StagedAttachment, filePath: string) => Promise<T>,
    scopeDigest?: string
  ): Promise<T> {
    return this.withRecord(handle, this.stagedAccess(), (record, filePath) => {
      if (!filePath) throw new Error("missing staged file path");
      return action(record, filePath);
    }, scopeDigest);
  }

  async cleanupExpired(now = new Date()): Promise<void> {
    await Promise.all([
      this.cleanupLayout(this.inspectedAccess(), now),
      this.cleanupLayout(this.stagedAccess(), now)
    ]);
  }

  private inspectedAccess(): RecordAccess<InspectedAttachment> {
    return {
      prefix: "qia_",
      recordType: "inspected",
      recordDirectory: this.inspectedRecordsDirectory,
      field: "attachment_handle",
      invalidCode: "INVALID_ATTACHMENT_HANDLE",
      invalidRecordCode: "ATTACHMENT_HANDLE_INVALID",
      missingCode: "ATTACHMENT_HANDLE_NOT_FOUND",
      expiredCode: "ATTACHMENT_HANDLE_EXPIRED"
    };
  }

  private stagedAccess(): RecordAccess<StagedAttachment> {
    return {
      prefix: "qis_",
      recordType: "staged",
      recordDirectory: this.stagedRecordsDirectory,
      fileDirectory: this.stagedFilesDirectory,
      fileId: (record) => record.staged_file_id,
      field: "staged_handle",
      invalidCode: "INVALID_STAGED_HANDLE",
      invalidRecordCode: "STAGED_HANDLE_INVALID",
      missingCode: "STAGED_HANDLE_NOT_FOUND",
      expiredCode: "STAGED_HANDLE_EXPIRED"
    };
  }

  private async writeRecord<T extends { handle_digest: string }>(
    buffer: Buffer,
    record: T,
    recordDirectory: string,
    fileDirectory: string,
    fileId: string
  ): Promise<void> {
    const filePath = path.join(fileDirectory, fileId);
    try {
      await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
      await writePrivateJson(path.join(recordDirectory, `${record.handle_digest}.json`), record);
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }

  private async withRecord<TRecord, TResult>(
    handle: string,
    access: RecordAccess<TRecord>,
    action: (record: TRecord, filePath?: string) => Promise<TResult>,
    scopeDigest?: string
  ): Promise<TResult> {
    assertHandle(handle, access as RecordAccess<unknown>);
    const claim = await this.claimRecord(access, handle);
    const filePath = access.fileDirectory && access.fileId
      ? path.join(access.fileDirectory, access.fileId(claim.record))
      : undefined;
    try {
      this.assertScope(claim.record, scopeDigest, access);
      this.assertNotExpired(claim.record, access);
      const result = await action(claim.record, filePath);
      await unlink(claim.leasePath);
      if (filePath) await rm(filePath, { force: true });
      return result;
    } catch (error) {
      await this.restoreClaim(claim);
      throw error;
    }
  }

  private assertScope<T>(record: T, scopeDigest: string | undefined, access: RecordAccess<T>): void {
    const recordScope = (record as { scope_digest?: unknown }).scope_digest;
    const matches = recordScope === undefined
      ? scopeDigest === undefined
      : typeof recordScope === "string" && typeof scopeDigest === "string" && secureEqual(recordScope, scopeDigest);
    if (!matches) {
      throw new PluginError(access.missingCode, "附件句柄不存在、已使用或正在使用。", {
        field: access.field
      });
    }
  }

  private async claimRecord<T>(access: RecordAccess<T>, handle: string): Promise<Claim<T>> {
    const digest = tokenDigest(handle);
    const originalPath = path.join(access.recordDirectory, `${digest}.json`);
    const leasePath = `${originalPath}.lease-${randomUUID()}`;
    try {
      await rename(originalPath, leasePath);
    } catch {
      throw new PluginError(access.missingCode, "附件句柄不存在、已使用或正在使用。", {
        field: access.field
      });
    }

    try {
      const record = JSON.parse(await readFile(leasePath, "utf8")) as T & {
        record_type?: string;
        handle_digest?: string;
      };
      if (record.record_type !== access.recordType || !record.handle_digest ||
        !secureEqual(record.handle_digest, digest)) {
        throw new PluginError(access.invalidRecordCode, "附件句柄记录校验失败。", { field: access.field });
      }
      return { record, originalPath, leasePath };
    } catch (error) {
      await rm(leasePath, { force: true });
      throw error;
    }
  }

  private assertNotExpired<T>(record: T, access: RecordAccess<T>): void {
    const expiresAt = (record as { expires_at?: unknown }).expires_at;
    const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      throw new PluginError(access.expiredCode, "附件句柄已过期。", {
        field: access.field,
        suggested_action: "重新检查当前对话附件。"
      });
    }
  }

  private async restoreClaim<T>(claim: Claim<T>): Promise<void> {
    try {
      await rename(claim.leasePath, claim.originalPath);
    } catch {
      await rm(claim.leasePath, { force: true });
    }
  }

  private async cleanupLayout<T>(access: RecordAccess<T>, now: Date): Promise<void> {
    const activeFileIds = await this.cleanupRecordDirectory(access, now);
    if (!access.fileDirectory) return;
    const entries = await readdir(access.fileDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || activeFileIds.has(entry.name)) continue;
      const filePath = path.join(access.fileDirectory, entry.name);
      const details = await stat(filePath);
      if (now.getTime() - details.mtimeMs >= HANDLE_TTL_MS) await rm(filePath, { force: true });
    }
  }

  private async cleanupRecordDirectory<T>(access: RecordAccess<T>, now: Date): Promise<Set<string>> {
    const activeFileIds = new Set<string>();
    const entries = await readdir(access.recordDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(".json")) continue;
      let filePath = path.join(access.recordDirectory, entry.name);
      try {
        const record = JSON.parse(await readFile(filePath, "utf8")) as T & {
          record_type?: string;
          expires_at?: string;
        };
        if (record.record_type !== access.recordType) throw new Error("unexpected attachment record type");
        const fileId = access.fileId?.(record);
        if (access.fileDirectory && !fileId) throw new Error("missing attachment file id");

        const leaseMarker = entry.name.indexOf(".json.lease-");
        if (leaseMarker !== -1) {
          const leaseDetails = await stat(filePath);
          // 正在处理的附件即使刚过期也不能被其他桥进程删除；失联租约才恢复后参与过期清理。
          if (now.getTime() - leaseDetails.mtimeMs < STALE_LEASE_MS) {
            if (fileId) activeFileIds.add(fileId);
            continue;
          }
          const originalPath = path.join(access.recordDirectory, entry.name.slice(0, leaseMarker + 5));
          try {
            await rename(filePath, originalPath);
            filePath = originalPath;
          } catch {
            await rm(filePath, { force: true });
            if (fileId) activeFileIds.add(fileId);
            continue;
          }
        }

        const expires = Date.parse(record.expires_at ?? "");
        if (!Number.isFinite(expires) || expires <= now.getTime()) {
          await rm(filePath, { force: true });
          if (access.fileDirectory && fileId) await rm(path.join(access.fileDirectory, fileId), { force: true });
          continue;
        }
        if (fileId) activeFileIds.add(fileId);
      } catch {
        await rm(filePath, { force: true });
      }
    }
    return activeFileIds;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PluginError("INSECURE_STATE_DIRECTORY", "本地附件处理状态目录不安全。", {
      suggested_action: "将 QUICK_IMAGE_DATA_DIR 指向仅当前用户可访问的真实目录。"
    });
  }
  if ((details.mode & 0o077) !== 0) await chmod(directory, 0o700);
}
