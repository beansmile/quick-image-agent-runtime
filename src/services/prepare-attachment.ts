import { createHash } from "node:crypto";
import { readSecureAttachmentFile, sameFileIdentity } from "../attachments/read-secure-file.js";
import { HANDLE_TTL_MS } from "../constants.js";
import { PluginError } from "../errors.js";
import { detectMedia } from "../media/detect.js";
import { processImage } from "../media/image.js";
import { inspectAudioVideo } from "../media/media-info.js";
import { HandleStore } from "../store/handle-store.js";
import type { PreparedAttachmentResult } from "../types.js";

export class PrepareAttachmentService {
  constructor(private readonly store: HandleStore) {}

  async execute(attachmentHandle: string, scopeDigest?: string): Promise<PreparedAttachmentResult> {
    return this.store.withInspection(attachmentHandle, async (record) => {
      let source;
      try {
        source = await readSecureAttachmentFile(record.source_path);
      } catch {
        throw attachmentChanged();
      }
      const input = source.buffer;
      const sourceChecksum = `sha256:${createHash("sha256").update(input).digest("hex")}`;
      const detected = detectMedia(input);
      if (!sameFileIdentity(source.identity, record.file_identity) || input.length !== record.size ||
        sourceChecksum !== record.source_checksum || detected.kind !== record.kind ||
        detected.format !== record.format || detected.contentType !== record.content_type) {
        throw attachmentChanged();
      }

      let finalBuffer = input;
      let metadata;
      if (record.kind === "image") {
        const processed = await processImage(input, record.format);
        finalBuffer = processed.buffer;
        metadata = processed.metadata;
      } else {
        metadata = await inspectAudioVideo(input, record.format);
      }

      const expiresAt = new Date(Date.now() + HANDLE_TTL_MS).toISOString();
      const checksum = `sha256:${createHash("sha256").update(finalBuffer).digest("hex")}`;
      const uploadChecksum = createHash("md5").update(finalBuffer).digest("base64");
      const stagedHandle = await this.store.createStage(finalBuffer, {
        record_type: "staged",
        ...(scopeDigest ? { scope_digest: scopeDigest } : {}),
        content_type: record.content_type,
        size: finalBuffer.length,
        checksum,
        expires_at: expiresAt
      });

      return {
        staged_handle: stagedHandle,
        create_direct_upload_args: {
          filename: record.filename,
          kind: record.kind,
          content_type: record.content_type,
          byte_size: finalBuffer.length,
          checksum,
          upload_checksum: uploadChecksum,
          metadata
        },
        expires_at: expiresAt
      };
    }, scopeDigest);
  }
}

function attachmentChanged(): PluginError {
  return new PluginError("ATTACHMENT_CHANGED", "附件在报价后发生变化或已不可读取，已拒绝处理。", {
    field: "attachment_handle",
    suggested_action: "请重新检查附件并确认最新报价。"
  });
}
