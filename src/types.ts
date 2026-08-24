export type MediaKind = "image" | "video" | "audio";
export type SupportedMediaFormat = "jpeg" | "png" | "webp" | "mp4" | "mov" | "wav" | "mp3";

export interface MediaMetadata {
  width?: number;
  height?: number;
  duration_seconds?: number;
  frame_rate?: number;
  audio_channels?: number;
  sample_rate?: number;
}

export interface AttachmentFileIdentity {
  device: string;
  inode: string;
  size: number;
  modified_at_ns: string;
  changed_at_ns: string;
}

export interface InspectedAttachment {
  record_type: "inspected";
  handle_digest: string;
  scope_digest?: string;
  source_path: string;
  filename: string;
  kind: MediaKind;
  format: SupportedMediaFormat;
  content_type: string;
  size: number;
  source_checksum: string;
  file_identity: AttachmentFileIdentity;
  metadata: MediaMetadata;
  expires_at: string;
}

export interface StagedAttachment {
  record_type: "staged";
  handle_digest: string;
  scope_digest?: string;
  staged_file_id: string;
  content_type: string;
  size: number;
  checksum: string;
  expires_at: string;
}

export interface InspectedAttachmentResult {
  attachment_handle: string;
  kind: MediaKind;
  content_type: string;
  byte_size: number;
  metadata: MediaMetadata;
  expires_at: string;
}

export interface CreateDirectUploadArguments {
  filename: string;
  kind: MediaKind;
  content_type: string;
  byte_size: number;
  checksum: string;
  upload_checksum: string;
  metadata: MediaMetadata;
}

export interface PreparedAttachmentResult {
  staged_handle: string;
  create_direct_upload_args: CreateDirectUploadArguments;
  expires_at: string;
}

export interface DirectUpload {
  asset_id: string;
  upload_url: string;
  headers: Record<string, string>;
  expires_at: string;
}
