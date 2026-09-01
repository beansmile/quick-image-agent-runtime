import { readFile } from "node:fs/promises";
import JSON5 from "json5";

export class OpenClawPolicyError extends Error {}

const OPENCLAW_PLUGIN_ID = "quick-image";
const REQUIRED_OPENCLAW_TOOLS = [
  "quick_image_list_attachments",
  "quick_image_inspect_attachment",
  "quick_image_prepare_attachment",
  "quick_image_estimate_lookbook_credits",
  "quick_image_estimate_pose_credits",
  "quick_image_estimate_upscale_credits",
  "quick_image_estimate_video_credits",
  "quick_image_upload_staged_attachment",
  "quick_image_send_preview"
] as const;

export async function checkOpenClawToolPolicy(configPath: string): Promise<void> {
  const config = JSON5.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const tools = isObject(config.tools) ? config.tools : {};
  const denied = stringList(tools.deny);
  const deniedTools = REQUIRED_OPENCLAW_TOOLS.filter((toolName) => toolMatchesPolicy(toolName, denied));
  if (deniedTools.length > 0) {
    throw new OpenClawPolicyError(
      `OpenClaw tools.deny 禁用了 ${deniedTools.join("、")}；请移除对应 deny 规则后重启 Gateway。`
    );
  }

  const allow = stringList(tools.allow);
  const alsoAllow = stringList(tools.alsoAllow);
  const profile = typeof tools.profile === "string" ? tools.profile.trim().toLowerCase() : "";
  const hasRestrictivePolicy = allow.length > 0 || (profile !== "" && profile !== "full");
  if (!hasRestrictivePolicy) return;

  const grantedTools = [...allow, ...alsoAllow];
  const missingTools = REQUIRED_OPENCLAW_TOOLS.filter((toolName) => !toolMatchesPolicy(toolName, grantedTools));
  if (missingTools.length === 0) return;

  throw new OpenClawPolicyError(
    `OpenClaw 工具策略未授权 ${missingTools.join("、")}；请将 quick-image 插件 ID ` +
    "加入 tools.alsoAllow 后重启 Gateway。"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
}

function toolMatchesPolicy(toolName: string, entries: string[]): boolean {
  return entries.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (normalized === "*" || normalized === "group:plugins" || normalized === OPENCLAW_PLUGIN_ID) {
      return true;
    }
    const pattern = normalized
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`).test(toolName);
  });
}
