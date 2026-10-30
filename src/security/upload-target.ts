import { PluginError } from "../errors.js";

/**
 * 直传目标的传输形态校验。
 *
 * 与下载侧（download-preview-media.ts）一致：服务端是权威，签发什么上传
 * 目标就按原样上传。不做域名允许列表，也不做 DNS 私网解析防护——
 * fake-IP 型出网隧道（沙箱环境、Clash fake-ip 等）会把全部域名解析到
 * RFC 2544 保留段占位地址，真实目的地由隧道按 TLS SNI 转发；自建部署
 * 也可能使用自有上传域名。DNS 层校验在这两类环境下只会误伤，传输安全
 * 由仅 HTTPS + TLS 证书校验 + 拒绝重定向保证。
 */
export interface UploadTargetPolicy {
  assertUrl(rawUrl: string): URL;
}

export function createUploadTargetPolicy(): UploadTargetPolicy {
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
        (url.port !== "" && url.port !== "443")
      ) {
        throw invalidTarget();
      }
      return url;
    }
  };
}

function invalidTarget(): PluginError {
  return new PluginError("UPLOAD_TARGET_REJECTED", "直传目标不符合 Quick Image 传输策略。", {
    field: "direct_upload.upload_url",
    suggested_action: "重新调用远程 MCP 获取直传信息；不要手工修改 URL。"
  });
}
