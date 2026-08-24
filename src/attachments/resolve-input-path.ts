import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginError } from "../errors.js";

const OPENCLAW_MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export async function resolveAttachmentInputPath(
  input: string,
  openClawStateDirectory = defaultOpenClawStateDirectory()
): Promise<string> {
  if (path.isAbsolute(input)) return input;
  if (!/^media:/i.test(input)) {
    throw new PluginError("ATTACHMENT_PATH_NOT_ABSOLUTE", "附件路径必须是绝对路径。", { field: "path" });
  }

  const mediaId = parseOpenClawInboundMediaId(input);
  const inboundDirectory = path.join(openClawStateDirectory, "media", "inbound");
  try {
    const details = await lstat(inboundDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("invalid inbound media directory");
  } catch {
    throw new PluginError("ATTACHMENT_MEDIA_STORE_UNAVAILABLE", "OpenClaw 入站媒体目录不可用。", {
      field: "path",
      suggested_action: "请确认附件来自当前 OpenClaw 会话后重试。"
    });
  }
  return path.join(inboundDirectory, mediaId);
}

function parseOpenClawInboundMediaId(input: string): string {
  try {
    const uri = new URL(input);
    const encodedId = uri.pathname.replace(/^\/+/, "");
    const mediaId = decodeURIComponent(encodedId);
    const valid = uri.protocol === "media:" && uri.hostname === "inbound" && !uri.port &&
      !uri.username && !uri.password && !uri.search && !uri.hash && OPENCLAW_MEDIA_ID.test(mediaId) &&
      mediaId !== "." && mediaId !== "..";
    if (valid) return mediaId;
  } catch {
    // Invalid and unsafe media references share one public error below.
  }
  throw new PluginError("ATTACHMENT_MEDIA_URI_INVALID", "OpenClaw 入站媒体引用无效。", { field: "path" });
}

function defaultOpenClawStateDirectory(): string {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".openclaw");
}
