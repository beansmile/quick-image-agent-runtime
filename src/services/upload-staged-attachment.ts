import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { HANDLE_TTL_MS, UPLOAD_TIMEOUT_MS } from "../constants.js";
import { PluginError } from "../errors.js";
import { createUploadTargetPolicy, type UploadTargetPolicy } from "../security/upload-target.js";
import { HandleStore } from "../store/handle-store.js";
import type { DirectUpload } from "../types.js";

const FORBIDDEN_HEADERS = new Set(["connection", "host", "transfer-encoding", "upgrade", "proxy-authorization"]);

export class UploadStagedAttachmentService {
  constructor(
    private readonly store: HandleStore,
    private readonly targetPolicy: UploadTargetPolicy = createUploadTargetPolicy(),
    private readonly uploader: typeof putBuffer = putBuffer
  ) {}

  async execute(
    stagedHandle: string,
    directUpload: DirectUpload,
    scopeDigest?: string
  ): Promise<{ asset_id: string }> {
    const uploadUrl = this.targetPolicy.assertUrl(directUpload.upload_url);
    validateDirectUpload(directUpload);

    return this.store.withStage(stagedHandle, async (record, stagedFilePath) => {
      const buffer = await readFile(stagedFilePath);
      const checksum = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
      if (buffer.length !== record.size || checksum !== record.checksum) {
        throw new PluginError("STAGED_ATTACHMENT_CHANGED", "暂存附件内容校验失败，已拒绝上传。", {
          field: "staged_handle",
          suggested_action: "重新准备当前对话附件并获取新的直传信息。"
        });
      }

      const headers = validateHeaders(directUpload.headers, record.size, record.content_type);
      await this.uploader(uploadUrl, headers, buffer, this.targetPolicy.lookup);
      return { asset_id: directUpload.asset_id };
    }, scopeDigest);
  }
}

function validateDirectUpload(directUpload: DirectUpload): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(directUpload.asset_id)) {
    throw new PluginError("INVALID_DIRECT_UPLOAD", "直传信息中的素材标识无效。", {
      field: "direct_upload.asset_id"
    });
  }
  const expires = Date.parse(directUpload.expires_at);
  const now = Date.now();
  if (!Number.isFinite(expires) || expires <= now || expires > now + HANDLE_TTL_MS + 5 * 60 * 1000) {
    throw new PluginError("DIRECT_UPLOAD_EXPIRED", "直传信息已过期或有效期异常。", {
      field: "direct_upload.expires_at",
      suggested_action: "重新调用远程 MCP 获取直传信息。"
    });
  }
}

function validateHeaders(input: Record<string, string>, size: number, contentType: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(name)) {
      throw new PluginError("UPLOAD_HEADER_REJECTED", "直传请求头不符合安全策略。", {
        field: "direct_upload.headers"
      });
    }
    if (typeof rawValue !== "string" || /[\r\n]/.test(rawValue)) {
      throw new PluginError("UPLOAD_HEADER_REJECTED", "直传请求头值无效。", {
        field: "direct_upload.headers"
      });
    }
    if (name === "content-length") {
      if (Number(rawValue) !== size) throw headerMismatch("content-length");
      continue;
    }
    if (name === "content-type" && rawValue.toLowerCase() !== contentType.toLowerCase()) {
      throw headerMismatch("content-type");
    }
    headers[name] = rawValue;
  }
  headers["content-length"] = String(size);
  if (!("content-type" in headers)) headers["content-type"] = contentType;
  return headers;
}

function putBuffer(
  url: URL,
  headers: Record<string, string>,
  buffer: Buffer,
  lookup: import("node:net").LookupFunction
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "PUT",
        headers,
        lookup,
        timeout: UPLOAD_TIMEOUT_MS,
        maxHeaderSize: 64 * 1024
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else if (status >= 300 && status < 400) reject(uploadError("UPLOAD_REDIRECT_REJECTED", false));
          else reject(uploadError("UPLOAD_FAILED", status >= 500 || status === 408 || status === 429));
        });
      }
    );
    request.once("timeout", () => request.destroy(uploadError("UPLOAD_TIMEOUT", true)));
    request.once("error", (error) => {
      reject(error instanceof PluginError ? error : uploadError("UPLOAD_NETWORK_ERROR", true));
    });
    request.end(buffer);
  });
}

function headerMismatch(header: string): PluginError {
  return new PluginError("UPLOAD_METADATA_MISMATCH", "直传信息与暂存附件元数据不一致。", {
    field: `direct_upload.headers.${header}`,
    suggested_action: "使用准备附件返回的最终元数据重新获取直传信息。"
  });
}

function uploadError(code: string, retryable: boolean): PluginError {
  return new PluginError(code, "附件直传未完成。", {
    retryable,
    suggested_action: retryable ? "保留同一暂存句柄并稍后重试。" : "重新获取直传信息。"
  });
}
