import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { MAX_INPUT_BYTES } from "../constants.js";
import { PluginError } from "../errors.js";
import type { AttachmentFileIdentity } from "../types.js";

export interface SecureAttachmentFile {
  buffer: Buffer;
  identity: AttachmentFileIdentity;
}

export async function readSecureAttachmentFile(filePath: string): Promise<SecureAttachmentFile> {
  const sourceDetails = await lstat(filePath);
  if (sourceDetails.isSymbolicLink() || !sourceDetails.isFile()) throw invalidFile();

  const file = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const current = await file.stat({ bigint: true });
    if (!current.isFile()) throw invalidFile();
    if (current.size > BigInt(MAX_INPUT_BYTES)) {
      throw new PluginError("ATTACHMENT_TOO_LARGE", "附件超过本地处理核心的最大读取限制。", {
        field: "size",
        current_value: Number(current.size),
        limit_value: MAX_INPUT_BYTES
      });
    }
    const before = fileIdentity(current);
    const buffer = await file.readFile();
    const after = fileIdentity(await file.stat({ bigint: true }));
    if (!sameFileIdentity(before, after) || buffer.length !== after.size) {
      throw new PluginError("ATTACHMENT_CHANGED", "附件在读取期间发生变化，已拒绝处理。", {
        field: "attachment",
        suggested_action: "请重新检查附件并确认最新报价。"
      });
    }
    return { buffer, identity: after };
  } finally {
    await file.close();
  }
}

function fileIdentity(details: BigIntStats): AttachmentFileIdentity {
  return {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: Number(details.size),
    modified_at_ns: details.mtimeNs.toString(),
    changed_at_ns: details.ctimeNs.toString()
  };
}

export function sameFileIdentity(left: AttachmentFileIdentity, right: AttachmentFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modified_at_ns === right.modified_at_ns && left.changed_at_ns === right.changed_at_ns;
}

function invalidFile(): PluginError {
  return new PluginError("ATTACHMENT_NOT_REGULAR_FILE", "附件必须是非符号链接的普通文件。", {
    field: "path"
  });
}
