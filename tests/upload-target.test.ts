import { describe, expect, it } from "vitest";
import { createUploadTargetPolicy, isPublicAddress } from "../src/security/upload-target.js";

describe("upload target policy", () => {
  const policy = createUploadTargetPolicy(["uploads.quickimage.ai", "*.oss.quickimage.ai"]);
  const defaultPolicy = createUploadTargetPolicy();

  it("accepts exact and bounded wildcard hosts", () => {
    expect(policy.assertUrl("https://uploads.quickimage.ai/object?signature=redacted").hostname).toBe(
      "uploads.quickimage.ai"
    );
    expect(policy.assertUrl("https://tenant.oss.quickimage.ai/object").hostname).toBe("tenant.oss.quickimage.ai");
  });

  it("accepts Aliyun OSS subdomains by default", () => {
    expect(defaultPolicy.assertUrl("https://example.oss-cn-shenzhen.aliyuncs.com/object").hostname).toBe(
      "example.oss-cn-shenzhen.aliyuncs.com"
    );
    expect(() => defaultPolicy.assertUrl("https://aliyuncs.com.evil.example/object"))
      .toThrowError(expect.objectContaining({ code: "UPLOAD_TARGET_REJECTED" }));
  });

  it.each([
    "http://uploads.quickimage.ai/object",
    "https://uploads.quickimage.ai.evil.example/object",
    "https://oss.quickimage.ai/object",
    "https://user:secret@uploads.quickimage.ai/object",
    "https://uploads.quickimage.ai:8443/object",
    "https://127.0.0.1/object"
  ])("rejects unsafe URL %s", (url) => {
    expect(() => policy.assertUrl(url)).toThrowError(expect.objectContaining({ code: "UPLOAD_TARGET_REJECTED" }));
  });

  it.each([
    ["127.0.0.1", false],
    ["10.0.0.1", false],
    ["169.254.1.1", false],
    ["100.64.0.1", false],
    ["::1", false],
    ["fc00::1", false],
    ["::ffff:127.0.0.1", false],
    ["8.8.8.8", true],
    ["2606:4700:4700::1111", true]
  ])("classifies %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});
