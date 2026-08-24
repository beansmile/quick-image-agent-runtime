import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { DEFAULT_UPLOAD_HOST_PATTERNS } from "../constants.js";
import { PluginError } from "../errors.js";

export interface UploadTargetPolicy {
  assertUrl(rawUrl: string): URL;
  lookup: LookupFunction;
}

export function createUploadTargetPolicy(patterns = configuredHostPatterns()): UploadTargetPolicy {
  const normalizedPatterns = patterns.map(normalizePattern);

  return {
    assertUrl(rawUrl: string): URL {
      if (rawUrl.length > 8192) throw invalidTarget();
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        throw invalidTarget();
      }
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        (url.port !== "" && url.port !== "443") ||
        !matchesAllowedHost(url.hostname, normalizedPatterns)
      ) {
        throw invalidTarget();
      }
      return url;
    },
    lookup: createSecureLookup()
  };
}

export function configuredHostPatterns(): string[] {
  const configured = process.env.QUICK_IMAGE_UPLOAD_HOSTS?.trim();
  if (!configured) return DEFAULT_UPLOAD_HOST_PATTERNS;
  const patterns = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (patterns.length === 0) throw invalidAllowlist();
  return patterns;
}

export function isPublicAddress(value: string): boolean {
  let address;
  try {
    address = ipaddr.parse(value);
  } catch {
    return false;
  }
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }
  return address.range() === "unicast";
}

function createSecureLookup(): LookupFunction {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    void dnsLookup(hostname, { all: true, verbatim: true })
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
          callback(Object.assign(new Error("Upload target resolved to a blocked address"), { code: "EACCES" }));
          return;
        }
        const wantsAll = typeof options === "object" && options !== null && "all" in options && options.all === true;
        if (wantsAll) callback(null, addresses);
        else callback(null, addresses[0]?.address, addresses[0]?.family);
      })
      .catch((error: unknown) => callback(error));
  }) as LookupFunction;
}

function normalizePattern(value: string): string {
  const pattern = value.trim().toLowerCase().replace(/\.$/, "");
  const bare = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  if (
    !bare.includes(".") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(bare) ||
    (pattern.includes("*") && !pattern.startsWith("*."))
  ) {
    throw invalidAllowlist();
  }
  return pattern;
}

function matchesAllowedHost(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) => {
    if (!pattern.startsWith("*.")) return host === pattern;
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  });
}

function invalidTarget(): PluginError {
  return new PluginError("UPLOAD_TARGET_REJECTED", "直传目标不符合 Quick Image 上传安全策略。", {
    field: "direct_upload.upload_url",
    suggested_action: "重新调用远程 MCP 获取直传信息；不要手工修改 URL。"
  });
}

function invalidAllowlist(): PluginError {
  return new PluginError("UPLOAD_ALLOWLIST_INVALID", "上传域名允许列表配置无效。", {
    suggested_action: "将 QUICK_IMAGE_UPLOAD_HOSTS 配置为逗号分隔的完整域名或 *.example.com。"
  });
}
