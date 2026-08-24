import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";

const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "quick-image-mcp-smoke-"));
const client = new Client({ name: "quick-image-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), "dist/server.js")],
  env: { ...process.env, QUICK_IMAGE_DATA_DIR: stateDirectory }
});

try {
  await client.connect(transport);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();
  const expected = [
    "estimate_lookbook_credits",
    "estimate_pose_credits",
    "estimate_upscale_credits",
    "estimate_video_credits",
    "inspect_attachment",
    "prepare_attachment",
    "upload_staged_attachment"
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected local tool list: ${names.join(",")}`);
  }
  const estimateRequiredFields = {
    estimate_lookbook_credits: ["output_count", "preset", "preset_price_behavior"],
    estimate_pose_credits: ["output_count_per_person", "person_count", "preset", "preset_price_behavior"],
    estimate_upscale_credits: ["input_count"],
    estimate_video_credits: ["input_video_duration_seconds", "output_duration_seconds"]
  };
  for (const [name, requiredFields] of Object.entries(estimateRequiredFields)) {
    const schema = result.tools.find((tool) => tool.name === name)?.inputSchema;
    const serializedSchema = JSON.stringify(schema);
    if (
      schema?.type !== "object" ||
      schema.additionalProperties !== false ||
      serializedSchema.includes('"capability"') ||
      serializedSchema.includes('"measurements"') ||
      !requiredFields.every((field) => schema.required?.includes(field))
    ) {
      throw new Error(`${name} does not expose a strict capability-specific schema`);
    }
  }
  const lookbookPresetUnitCreditsSchema = result.tools
    .find((tool) => tool.name === "estimate_lookbook_credits")
    ?.inputSchema?.properties?.preset?.anyOf?.find((schema) => schema.type === "object")
    ?.properties?.unit_credits;
  const videoInputDurationSchema = result.tools
    .find((tool) => tool.name === "estimate_video_credits")
    ?.inputSchema?.properties?.input_video_duration_seconds;
  if (
    JSON.stringify(lookbookPresetUnitCreditsSchema?.type) !== JSON.stringify(["integer", "null"]) ||
    JSON.stringify(videoInputDurationSchema?.type) !== JSON.stringify(["number", "null"])
  ) {
    throw new Error("nullable numeric estimate fields must use a non-coercing JSON Schema type union");
  }
  const schemas = JSON.stringify(result.tools.map((tool) => tool.inputSchema)).toLowerCase();
  if (!schemas.includes('"path"') || schemas.includes('"attachment_id"') ||
      !schemas.includes('"attachment_handle"') || !schemas.includes('"staged_handle"') ||
      schemas.includes('"captured_handle"') ||
      schemas.includes("base64") || schemas.includes("bearer")) {
    throw new Error("local tool schemas do not expose the expected inspection and preparation contract");
  }
  const confirmationThresholds = { output_count: 8, image_credits: 200, video_credits: 500 };
  const lookbookEstimate = await client.callTool({
    name: "estimate_lookbook_credits",
    arguments: {
      estimation_contract_version: 1,
      pricing: { billing_strategy: "output_count", unit_credits: 10 },
      preset: {
        preset_id: "lookbook-model-priced",
        preset_kind: "lookbook_style",
        name: "Model-priced lookbook",
        description: "Uses model pricing when the preset has no custom price.",
        billing_strategy: "output_count",
        unit_credits: null
      },
      preset_price_behavior: "override_model",
      output_count: 1,
      confirmation_thresholds: confirmationThresholds
    }
  });
  if (
    lookbookEstimate.isError ||
    lookbookEstimate.structuredContent?.estimated_credits !== 10 ||
    lookbookEstimate.structuredContent?.estimated_output_count !== 1
  ) {
    throw new Error(`estimate_lookbook_credits returned an invalid estimate: ${JSON.stringify(lookbookEstimate)}`);
  }
  const poseEstimate = await client.callTool({
    name: "estimate_pose_credits",
    arguments: {
      estimation_contract_version: 1,
      pricing: { billing_strategy: "person_output_count", unit_credits: 4 },
      preset: { billing_strategy: "person_output_count", unit_credits: null },
      preset_price_behavior: "override_model",
      person_count: 2,
      output_count_per_person: 3,
      confirmation_thresholds: confirmationThresholds
    }
  });
  if (
    poseEstimate.isError ||
    poseEstimate.structuredContent?.estimated_credits !== 24 ||
    poseEstimate.structuredContent?.estimated_output_count !== 6
  ) {
    throw new Error(`estimate_pose_credits returned an invalid estimate: ${JSON.stringify(poseEstimate)}`);
  }
  const upscaleEstimate = await client.callTool({
    name: "estimate_upscale_credits",
    arguments: {
      estimation_contract_version: 1,
      pricing: { billing_strategy: "input_count", unit_credits: 4 },
      input_count: 2,
      confirmation_thresholds: confirmationThresholds
    }
  });
  if (upscaleEstimate.isError || upscaleEstimate.structuredContent?.estimated_credits !== 8) {
    throw new Error(`estimate_upscale_credits returned an invalid estimate: ${JSON.stringify(upscaleEstimate)}`);
  }
  const videoEstimate = await client.callTool({
    name: "estimate_video_credits",
    arguments: {
      estimation_contract_version: 1,
      pricing: { billing_strategy: "output_duration", credits_per_second: 4, rounding: "ceil" },
      output_duration_seconds: 5,
      input_video_duration_seconds: null,
      confirmation_thresholds: confirmationThresholds
    }
  });
  if (videoEstimate.isError || videoEstimate.structuredContent?.estimated_credits !== 20) {
    throw new Error(`estimate_video_credits returned an invalid estimate: ${JSON.stringify(videoEstimate)}`);
  }
  const invalidVideoEstimate = await client.callTool({
    name: "estimate_video_credits",
    arguments: {
      estimation_contract_version: 1,
      pricing: { billing_strategy: "input_plus_output_duration", credits_per_second: 4, rounding: "ceil" },
      output_duration_seconds: 5,
      confirmation_thresholds: confirmationThresholds
    }
  });
  if (!invalidVideoEstimate.isError) {
    throw new Error("estimate_video_credits accepted a missing input video duration");
  }
  const missingPath = path.join(stateDirectory, "missing.png");
  const missing = await client.callTool({ name: "inspect_attachment", arguments: { path: missingPath } });
  if (!missing.isError || JSON.stringify(missing).includes(missingPath)) {
    throw new Error("inspect_attachment did not redact a local filesystem error");
  }
  const imagePath = path.join(stateDirectory, "smoke.png");
  await writeFile(imagePath, await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 24, g: 120, b: 80 } }
  }).png().toBuffer());
  const inspected = await client.callTool({ name: "inspect_attachment", arguments: { path: imagePath } });
  if (inspected.isError || !inspected.structuredContent?.attachment_handle ||
      inspected.structuredContent?.byte_size <= 0 || inspected.structuredContent?.metadata?.width !== 32) {
    throw new Error("inspect_attachment did not return an attachment handle and media metadata");
  }
  if (JSON.stringify(inspected).includes(imagePath)) {
    throw new Error("inspect_attachment response leaked the local path");
  }
  const prepared = await client.callTool({
    name: "prepare_attachment",
    arguments: { attachment_handle: inspected.structuredContent.attachment_handle }
  });
  const directUploadArguments = prepared.structuredContent?.create_direct_upload_args;
  if (
    prepared.isError ||
    !prepared.structuredContent?.staged_handle ||
    typeof directUploadArguments?.checksum !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(directUploadArguments.checksum)
  ) {
    throw new Error("prepare_attachment did not return a staged handle and valid direct-upload arguments");
  }
  const offsetExpiry = new Date(Date.now() + 8 * 60 * 60 * 1000 + 60_000)
    .toISOString()
    .replace("Z", "+08:00");
  const offsetResult = await client.callTool({
    name: "upload_staged_attachment",
    arguments: {
      staged_handle: `qis_${"A".repeat(43)}`,
      direct_upload: {
        asset_id: "asset_smoke",
        upload_url: "https://uploads.quickimage.ai/smoke",
        headers: {},
        expires_at: offsetExpiry
      }
    }
  });
  if (!offsetResult.isError || !JSON.stringify(offsetResult).includes("STAGED_HANDLE_NOT_FOUND")) {
    throw new Error(
      `upload_staged_attachment did not accept an ISO 8601 datetime with an offset: ${JSON.stringify(offsetResult)}`
    );
  }
  process.stdout.write(`MCP smoke test passed: ${names.join(", ")}\n`);
} finally {
  await client.close().catch(() => undefined);
  await rm(stateDirectory, { recursive: true, force: true });
}
