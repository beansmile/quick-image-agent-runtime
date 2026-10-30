import { describe, expect, it } from "vitest";
import { createUploadTargetPolicy } from "../src/security/upload-target.js";

describe("upload target policy", () => {
  const policy = createUploadTargetPolicy();

  it.each([
    "https://uploads.quickimage.ai/object?signature=redacted",
    "https://example.oss-cn-shenzhen.aliyuncs.com/object",
    "https://storage.self-hosted.example.com/object",
    "https://198.18.0.1/object"
  ])("accepts any server-issued https upload target %s", (url) => {
    expect(policy.assertUrl(url)).toBeInstanceOf(URL);
  });

  it.each([
    "not a url",
    "http://uploads.quickimage.ai/object",
    "https://user:secret@uploads.quickimage.ai/object",
    "https://uploads.quickimage.ai:8443/object",
    "https://uploads.quickimage.ai/object#fragment",
    `https://uploads.quickimage.ai/${"a".repeat(8200)}`
  ])("rejects unsafe URL %s", (url) => {
    expect(() => policy.assertUrl(url)).toThrowError(
      expect.objectContaining({ code: "UPLOAD_TARGET_REJECTED" })
    );
  });
});
