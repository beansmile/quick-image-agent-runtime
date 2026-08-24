import { createHash } from "node:crypto";
import path from "node:path";
import { readSecureAttachmentFile } from "../attachments/read-secure-file.js";
import { resolveAttachmentInputPath } from "../attachments/resolve-input-path.js";
import { HANDLE_TTL_MS, MAX_AUDIO_BYTES, MAX_INPUT_BYTES, MAX_VIDEO_BYTES } from "../constants.js";
import { PluginError } from "../errors.js";
import { detectMedia } from "../media/detect.js";
import { inspectImage } from "../media/image.js";
import { inspectAudioVideo } from "../media/media-info.js";
import { HandleStore } from "../store/handle-store.js";
import type { InspectedAttachmentResult, MediaKind } from "../types.js";

export class InspectAttachmentService {
  constructor(
    private readonly store: HandleStore,
    private readonly openClawStateDirectory?: string
  ) {}

  async execute(inputPath: string, scopeDigest?: string): Promise<InspectedAttachmentResult> {
    const filePath = await resolveAttachmentInputPath(inputPath, this.openClawStateDirectory);
    const source = await readSecureAttachmentFile(filePath);
    const detected = detectMedia(source.buffer);
    assertSourceSize(detected.kind, source.buffer.length);
    const metadata = detected.kind === "image"
      ? await inspectImage(source.buffer, detected.format)
      : await inspectAudioVideo(source.buffer, detected.format);
    const expiresAt = new Date(Date.now() + HANDLE_TTL_MS).toISOString();
    const sourceChecksum = `sha256:${createHash("sha256").update(source.buffer).digest("hex")}`;
    const filename = normalizeFileName(path.basename(filePath), detected.extension);
    const attachmentHandle = await this.store.createInspection({
      record_type: "inspected",
      ...(scopeDigest ? { scope_digest: scopeDigest } : {}),
      source_path: filePath,
      filename,
      kind: detected.kind,
      format: detected.format,
      content_type: detected.contentType,
      size: source.buffer.length,
      source_checksum: sourceChecksum,
      file_identity: source.identity,
      metadata,
      expires_at: expiresAt
    });

    return {
      attachment_handle: attachmentHandle,
      kind: detected.kind,
      content_type: detected.contentType,
      byte_size: source.buffer.length,
      metadata,
      expires_at: expiresAt
    };
  }
}

function assertSourceSize(kind: MediaKind, size: number): void {
  const limit = kind === "video" ? MAX_VIDEO_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : MAX_INPUT_BYTES;
  if (size > limit) {
    throw new PluginError("MEDIA_SIZE_EXCEEDED", "附件大小超过允许范围。", {
      field: "size",
      current_value: size,
      limit_value: limit
    });
  }
  if (kind === "image" && size === 0) {
    throw new PluginError("INVALID_IMAGE", "图片文件为空。", { field: "attachment" });
  }
}

function normalizeFileName(displayName: string, extension: string): string {
  const originalExtension = path.extname(displayName);
  const stem = path.basename(displayName, originalExtension).replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return `${(stem || "attachment").slice(0, 200)}${extension}`;
}
