#!/usr/bin/env node

// package.json
var package_default = {
  name: "quick-image-agent-runtime",
  version: "0.1.0",
  private: true,
  description: "Quick Image local processing runtime for agent hosts",
  type: "module",
  license: "LicenseRef-Quick-Image",
  repository: {
    type: "git",
    url: "git+https://github.com/beansmile/quick-image-agent-runtime.git"
  },
  engines: {
    node: ">=20"
  },
  packageManager: "pnpm@10.19.0",
  bin: {
    "quick-image-local-mcp": "./dist/server.js"
  },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js"
    }
  },
  files: [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  scripts: {
    build: "tsup",
    clean: "rimraf dist coverage",
    check: "pnpm typecheck && pnpm test && pnpm build && pnpm validate && pnpm mcp:smoke && pnpm pack:check",
    dev: "tsx src/server.ts",
    "mcp:smoke": "node scripts/smoke-mcp.mjs",
    "pack:check": "npm pack --dry-run",
    test: "vitest run",
    typecheck: "tsc --noEmit",
    validate: "node scripts/validate-package.mjs"
  },
  dependencies: {
    "@modelcontextprotocol/sdk": "1.30.0",
    "ipaddr.js": "2.2.0",
    "mediainfo.js": "0.3.7",
    sharp: "0.35.3",
    zod: "3.25.76"
  },
  devDependencies: {
    "@types/node": "24.3.0",
    rimraf: "6.0.1",
    tsup: "8.5.0",
    tsx: "4.20.5",
    typescript: "5.9.2",
    vitest: "3.2.4"
  }
};

// src/constants.ts
var RUNTIME_VERSION = package_default.version;
var HANDLE_TTL_MS = 24 * 60 * 60 * 1e3;
var HANDLE_CLEANUP_INTERVAL_MS = 10 * 60 * 1e3;
var MAX_IMAGE_BYTES = Math.floor(6.5 * 1024 * 1024);
var MAX_VIDEO_BYTES = 200 * 1024 * 1024;
var MAX_AUDIO_BYTES = 15 * 1024 * 1024;
var MAX_INPUT_BYTES = MAX_VIDEO_BYTES;
var MAX_IMAGE_EDGE = 3072;
var MIN_MEDIA_DURATION_SECONDS = 2;
var MAX_MEDIA_DURATION_SECONDS = 15;
var UPLOAD_TIMEOUT_MS = 5 * 60 * 1e3;
var DEFAULT_UPLOAD_HOST_PATTERNS = ["quickimage.ai", "*.quickimage.ai", "*.aliyuncs.com"];

// src/contracts/local-tool-schemas.ts
import { z } from "zod";
import * as z4 from "zod/v4";
var mediaMetadataSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().positive().optional(),
  frame_rate: z.number().positive().optional(),
  audio_channels: z.number().int().positive().optional(),
  sample_rate: z.number().int().positive().optional()
});
var createDirectUploadArgumentsSchema = z.object({
  filename: z.string().min(1).max(255),
  kind: z.enum(["image", "video", "audio"]),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  upload_checksum: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  metadata: mediaMetadataSchema
});
var preparedOutputSchema = z.object({
  staged_handle: z.string(),
  create_direct_upload_args: createDirectUploadArgumentsSchema,
  expires_at: z.string().datetime()
});
var inspectedOutputSchema = z.object({
  attachment_handle: z.string(),
  kind: z.enum(["image", "video", "audio"]),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  metadata: mediaMetadataSchema,
  expires_at: z.string().datetime()
});
var directUploadSchema = z.object({
  asset_id: z.string().min(1).max(200),
  upload_url: z.string().url().max(8192),
  headers: z.record(z.string()),
  expires_at: z.string().datetime({ offset: true })
});
var confirmationThresholdsSchema = z4.object({
  output_count: z4.number().int().positive(),
  image_credits: z4.number().int().positive(),
  video_credits: z4.number().int().positive()
});
var estimationBaseShape = {
  estimation_contract_version: z4.literal(1).describe("get_generation_config \u8FD4\u56DE\u7684\u672C\u5730\u4F30\u4EF7\u5951\u7EA6\u7248\u672C"),
  confirmation_thresholds: confirmationThresholdsSchema.describe("get_generation_config \u8FD4\u56DE\u7684\u5B8C\u6574\u786E\u8BA4\u9608\u503C")
};
var lookbookPricingSchema = z4.object({
  billing_strategy: z4.literal("output_count"),
  unit_credits: z4.number().int().positive()
}).strict();
var posePricingSchema = z4.object({
  billing_strategy: z4.literal("person_output_count"),
  unit_credits: z4.number().int().positive()
}).strict();
var upscalePricingSchema = z4.object({
  billing_strategy: z4.literal("input_count"),
  unit_credits: z4.number().int().positive()
}).strict();
var videoPricingSchema = z4.discriminatedUnion("billing_strategy", [
  z4.object({
    billing_strategy: z4.literal("output_duration"),
    credits_per_second: z4.number().positive(),
    rounding: z4.literal("ceil")
  }).strict(),
  z4.object({
    billing_strategy: z4.literal("input_plus_output_duration"),
    credits_per_second: z4.number().positive(),
    rounding: z4.literal("ceil")
  }).strict()
]);
function presetPricingCandidateSchema(billingStrategy) {
  return z4.object({
    billing_strategy: z4.literal(billingStrategy),
    unit_credits: nullableIntegerSchema("\u9884\u8BBE\u5355\u4EF7\uFF1B\u4E3A null \u65F6\u4F7F\u7528\u6A21\u578B\u4EF7\u683C")
  }).passthrough();
}
var lookbookEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: lookbookPricingSchema.describe("\u6240\u9009\u642D\u914D\u6A21\u578B\u4E0E\u5206\u8FA8\u7387\u7684\u5B8C\u6574\u4EF7\u683C\u9879"),
  preset: presetPricingCandidateSchema("output_count").nullable().describe("\u6240\u9009\u642D\u914D\u9884\u8BBE\u5B8C\u6574\u5BF9\u8C61\uFF1B\u672A\u9009\u62E9\u9884\u8BBE\u65F6\u4F20 null"),
  preset_price_behavior: z4.enum(["override_model", "use_model"]).describe("\u6240\u9009\u642D\u914D\u6A21\u578B\u8FD4\u56DE\u7684\u9884\u8BBE\u4EF7\u683C\u884C\u4E3A"),
  output_count: z4.number().int().positive().describe("\u672C\u6B21\u642D\u914D\u8F93\u51FA\u56FE\u7247\u6570\u91CF")
}).strict();
var poseEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: posePricingSchema.describe("\u6240\u9009\u6362\u59FF\u6A21\u578B\u4E0E\u5206\u8FA8\u7387\u7684\u5B8C\u6574\u4EF7\u683C\u9879"),
  preset: presetPricingCandidateSchema("person_output_count").nullable().describe("\u6240\u9009\u6362\u59FF\u9884\u8BBE\u5B8C\u6574\u5BF9\u8C61\uFF1B\u672A\u9009\u62E9\u9884\u8BBE\u65F6\u4F20 null"),
  preset_price_behavior: z4.enum(["override_model", "use_model"]).describe("\u6240\u9009\u6362\u59FF\u6A21\u578B\u8FD4\u56DE\u7684\u9884\u8BBE\u4EF7\u683C\u884C\u4E3A"),
  person_count: z4.number().int().positive().describe("\u672C\u6B21\u6362\u59FF\u8F93\u5165\u4EBA\u7269\u56FE\u7247\u6570\u91CF"),
  output_count_per_person: z4.number().int().positive().describe("\u6BCF\u4E2A\u4EBA\u7269\u751F\u6210\u7684\u56FE\u7247\u6570\u91CF")
}).strict();
var upscaleEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: upscalePricingSchema.describe("\u5F53\u524D\u914D\u7F6E\u8FD4\u56DE\u7684\u5B8C\u6574\u9AD8\u6E05\u4EF7\u683C\u9879"),
  input_count: z4.number().int().positive().describe("\u672C\u6B21\u9AD8\u6E05\u8F93\u5165\u56FE\u7247\u6570\u91CF")
}).strict();
var videoEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: videoPricingSchema.describe("\u6240\u9009\u89C6\u9891\u6A21\u578B\u3001\u5206\u8FA8\u7387\u548C\u8F93\u5165\u6761\u4EF6\u5BF9\u5E94\u7684\u5B8C\u6574\u4EF7\u683C\u9879"),
  output_duration_seconds: z4.number().positive().describe("\u672C\u6B21\u751F\u6210\u89C6\u9891\u7684\u8F93\u51FA\u603B\u65F6\u957F"),
  input_video_duration_seconds: nullablePositiveNumberSchema(
    "inspect_attachment \u8FD4\u56DE\u7684\u8F93\u5165\u89C6\u9891\u603B\u65F6\u957F\uFF1B\u6CA1\u6709\u89C6\u9891\u8F93\u5165\u65F6\u4F20 null"
  )
}).strict();
var estimateOutputSchema = z.object({
  estimated_credits: z.number().int().positive(),
  estimated_output_count: z.number().int().positive(),
  confirmation_reasons: z.array(z.enum([
    "output_count_threshold",
    "image_credits_threshold",
    "video_credits_threshold"
  ])),
  calculation: z.object({
    billing_strategy: z.enum([
      "output_count",
      "person_output_count",
      "input_count",
      "output_duration",
      "input_plus_output_duration"
    ]),
    rate: z.number().positive(),
    billable_units: z.number().positive(),
    unrounded_credits: z.number().positive(),
    rounding: z.enum(["none", "ceil"])
  })
});
function nullableIntegerSchema(description) {
  const schema = z4.union([z4.number().int(), z4.null()]).describe(description);
  schema._zod.toJSONSchema = () => ({ type: ["integer", "null"] });
  return schema;
}
function nullablePositiveNumberSchema(description) {
  const schema = z4.union([z4.number().positive(), z4.null()]).describe(description);
  schema._zod.toJSONSchema = () => ({ type: ["number", "null"], exclusiveMinimum: 0 });
  return schema;
}

// src/errors.ts
var PluginError = class extends Error {
  code;
  details;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }
  toPublicObject() {
    return {
      code: this.code,
      message: this.message,
      ...this.details
    };
  }
};
function toPluginError(error) {
  if (error instanceof PluginError) return error;
  return new PluginError("LOCAL_TOOL_ERROR", "Quick Image \u672C\u5730\u5DE5\u5177\u5904\u7406\u5931\u8D25\u3002", {
    retryable: false,
    suggested_action: "\u8FD0\u884C quick-image-doctor\uFF0C\u5E76\u5728\u8131\u654F\u540E\u63D0\u4F9B\u9519\u8BEF\u7801\u3002"
  });
}

// src/pricing/estimate-generation-credits.ts
var BILLING_STRATEGIES = [
  "output_count",
  "person_output_count",
  "input_count",
  "output_duration",
  "input_plus_output_duration"
];
function estimateGenerationCredits(input) {
  if (input.estimation_contract_version !== 1) {
    throw invalidEstimate("\u4E0D\u652F\u6301\u5F53\u524D\u672C\u5730\u62A5\u4EF7\u5951\u7EA6\u7248\u672C\u3002");
  }
  const pricing = resolveEffectivePricing(input);
  const factors = resolveBillingFactors(pricing, input.measurements);
  validateThresholds(input.confirmation_thresholds);
  const unroundedCredits = factors.rate * factors.billableUnits;
  const estimatedCredits = factors.rounding === "ceil" ? stableCeil(unroundedCredits) : unroundedCredits;
  if (!Number.isSafeInteger(estimatedCredits) || estimatedCredits <= 0) {
    throw invalidEstimate("\u9884\u8BA1\u79EF\u5206\u4E0D\u662F\u6709\u9650\u6B63\u6574\u6570\u3002");
  }
  const confirmationReasons = [];
  if (factors.outputCount >= input.confirmation_thresholds.output_count) {
    confirmationReasons.push("output_count_threshold");
  }
  const creditsThreshold = factors.mediaKind === "video" ? input.confirmation_thresholds.video_credits : input.confirmation_thresholds.image_credits;
  if (estimatedCredits >= creditsThreshold) {
    confirmationReasons.push(
      factors.mediaKind === "video" ? "video_credits_threshold" : "image_credits_threshold"
    );
  }
  return {
    estimated_credits: estimatedCredits,
    estimated_output_count: factors.outputCount,
    confirmation_reasons: confirmationReasons,
    calculation: {
      billing_strategy: pricing.billing_strategy,
      rate: factors.rate,
      billable_units: factors.billableUnits,
      unrounded_credits: unroundedCredits,
      rounding: factors.rounding
    }
  };
}
function resolveEffectivePricing(input) {
  const preset = input.preset;
  if (!preset) return input.pricing;
  if (preset.unit_credits === null) return input.pricing;
  const unitCredits = requirePositiveInteger(preset.unit_credits, "preset.unit_credits");
  if (!input.preset_price_behavior) {
    throw invalidEstimate("\u5E26\u4EF7\u683C\u7684\u9884\u8BBE\u7F3A\u5C11\u4EF7\u683C\u9009\u62E9\u884C\u4E3A\u3002", "preset_price_behavior");
  }
  if (input.preset_price_behavior === "use_model") return input.pricing;
  if (!isImagePricingPlan(input.pricing)) {
    throw invalidEstimate("\u9884\u8BBE\u4EF7\u683C\u53EA\u80FD\u7528\u4E8E\u642D\u914D\u6216\u6362\u59FF\u56FE\u7247\u8BA1\u8D39\u3002", "pricing.billing_strategy");
  }
  if (preset.billing_strategy !== input.pricing.billing_strategy) {
    throw invalidEstimate("\u9884\u8BBE\u4E0E\u6A21\u578B\u4EF7\u683C\u7684\u8BA1\u8D39\u7B56\u7565\u4E0D\u4E00\u81F4\u3002", "preset.billing_strategy");
  }
  return { billing_strategy: preset.billing_strategy, unit_credits: unitCredits };
}
function isImagePricingPlan(pricing) {
  return pricing.billing_strategy === "output_count" || pricing.billing_strategy === "person_output_count";
}
function resolveBillingFactors(pricing, measurements) {
  switch (pricing.billing_strategy) {
    case "output_count":
      return unitFactors(pricing.unit_credits, requirePositiveInteger(measurements.output_count, "output_count"));
    case "person_output_count": {
      const personCount = requirePositiveInteger(measurements.person_count, "person_count");
      const outputCountPerPerson = requirePositiveInteger(
        measurements.output_count_per_person,
        "output_count_per_person"
      );
      return unitFactors(pricing.unit_credits, personCount * outputCountPerPerson);
    }
    case "input_count":
      return unitFactors(pricing.unit_credits, requirePositiveInteger(measurements.input_count, "input_count"));
    case "output_duration":
      return durationFactors(
        pricing.credits_per_second,
        requirePositiveNumber(measurements.output_duration_seconds, "output_duration_seconds")
      );
    case "input_plus_output_duration": {
      const outputDuration = requirePositiveNumber(
        measurements.output_duration_seconds,
        "output_duration_seconds"
      );
      const inputDuration = requirePositiveNumber(
        measurements.input_video_duration_seconds,
        "input_video_duration_seconds"
      );
      return durationFactors(pricing.credits_per_second, inputDuration + outputDuration);
    }
  }
}
function unitFactors(unitCredits, quantity) {
  return {
    rate: requirePositiveInteger(unitCredits, "unit_credits"),
    billableUnits: quantity,
    outputCount: quantity,
    rounding: "none",
    mediaKind: "image"
  };
}
function durationFactors(creditsPerSecond, seconds) {
  return {
    rate: requirePositiveNumber(creditsPerSecond, "credits_per_second"),
    billableUnits: seconds,
    outputCount: 1,
    rounding: "ceil",
    mediaKind: "video"
  };
}
function stableCeil(value) {
  const nearestInteger = Math.round(value);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
  return Math.abs(value - nearestInteger) <= floatingPointTolerance ? nearestInteger : Math.ceil(value);
}
function validateThresholds(thresholds) {
  requirePositiveInteger(thresholds.output_count, "confirmation_thresholds.output_count");
  requirePositiveInteger(thresholds.image_credits, "confirmation_thresholds.image_credits");
  requirePositiveInteger(thresholds.video_credits, "confirmation_thresholds.video_credits");
}
function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw invalidEstimate(`\u62A5\u4EF7\u5B57\u6BB5 ${field} \u5FC5\u987B\u662F\u6B63\u6574\u6570\u3002`, field);
  }
  return value;
}
function requirePositiveNumber(value, field) {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    throw invalidEstimate(`\u62A5\u4EF7\u5B57\u6BB5 ${field} \u5FC5\u987B\u662F\u6709\u9650\u6B63\u6570\u3002`, field);
  }
  return value;
}
function invalidEstimate(message, field) {
  return new PluginError("ESTIMATE_INPUT_INVALID", message, {
    ...field ? { field } : {},
    retryable: false,
    suggested_action: "\u91CD\u65B0\u8BFB\u53D6\u751F\u6210\u914D\u7F6E\u548C\u9644\u4EF6\u5143\u6570\u636E\u540E\u518D\u9884\u4F30\u3002"
  });
}

// src/runtime.ts
import os from "os";
import path from "path";
function assertSupportedRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 20) {
    throw new PluginError("NODE_VERSION_UNSUPPORTED", "Quick Image \u672C\u5730\u9644\u4EF6\u5904\u7406\u6838\u5FC3\u9700\u8981 Node.js 20 \u6216\u66F4\u9AD8\u7248\u672C\u3002", {
      current_value: process.versions.node,
      limit_value: ">=20",
      suggested_action: "\u5347\u7EA7 Node.js \u540E\u91CD\u65B0\u542F\u52A8\u5BBF\u4E3B\u3002"
    });
  }
  if (process.platform === "win32") {
    throw new PluginError("NATIVE_WINDOWS_UNSUPPORTED", "Quick Image P0 \u4E0D\u652F\u6301\u539F\u751F Windows\u3002", {
      suggested_action: "\u8BF7\u5728 Windows WSL2 \u4E2D\u5B89\u88C5\u5E76\u8FD0\u884C\u63D2\u4EF6\u3002"
    });
  }
}
async function assertRuntimeDependencies() {
  await Promise.all([import("sharp"), import("mediainfo.js")]);
}
function resolveDataDirectory() {
  const explicit = process.env.QUICK_IMAGE_DATA_DIR?.trim();
  const pluginData = process.env.PLUGIN_DATA?.trim();
  const base = explicit || pluginData;
  if (base) return path.resolve(base, "upload-bridge");
  const xdgState = process.env.XDG_STATE_HOME?.trim();
  if (xdgState) return path.resolve(xdgState, "quick-image-agent-runtime");
  return path.join(os.homedir(), ".local", "state", "quick-image-agent-runtime");
}
function resolveOpenClawAttachmentRegistryDirectory() {
  const explicit = process.env.QUICK_IMAGE_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit, "upload-bridge");
  const xdgState = process.env.XDG_STATE_HOME?.trim();
  if (xdgState) return path.resolve(xdgState, "quick-image-agent-runtime");
  return path.join(os.homedir(), ".local", "state", "quick-image-agent-runtime");
}

// src/security/upload-target.ts
import { lookup as dnsLookup } from "dns/promises";
import ipaddr from "ipaddr.js";
function createUploadTargetPolicy(patterns = configuredHostPatterns()) {
  const normalizedPatterns = patterns.map(normalizePattern);
  return {
    assertUrl(rawUrl) {
      if (rawUrl.length > 8192) throw invalidTarget();
      let url;
      try {
        url = new URL(rawUrl);
      } catch {
        throw invalidTarget();
      }
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || url.port !== "" && url.port !== "443" || !matchesAllowedHost(url.hostname, normalizedPatterns)) {
        throw invalidTarget();
      }
      return url;
    },
    lookup: createSecureLookup()
  };
}
function configuredHostPatterns() {
  const configured = process.env.QUICK_IMAGE_UPLOAD_HOSTS?.trim();
  if (!configured) return DEFAULT_UPLOAD_HOST_PATTERNS;
  const patterns = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (patterns.length === 0) throw invalidAllowlist();
  return patterns;
}
function isPublicAddress(value) {
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
function createSecureLookup() {
  return ((hostname, options, callback) => {
    void dnsLookup(hostname, { all: true, verbatim: true }).then((addresses) => {
      if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        callback(Object.assign(new Error("Upload target resolved to a blocked address"), { code: "EACCES" }));
        return;
      }
      const wantsAll = typeof options === "object" && options !== null && "all" in options && options.all === true;
      if (wantsAll) callback(null, addresses);
      else callback(null, addresses[0]?.address, addresses[0]?.family);
    }).catch((error) => callback(error));
  });
}
function normalizePattern(value) {
  const pattern = value.trim().toLowerCase().replace(/\.$/, "");
  const bare = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  if (!bare.includes(".") || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(bare) || pattern.includes("*") && !pattern.startsWith("*.")) {
    throw invalidAllowlist();
  }
  return pattern;
}
function matchesAllowedHost(hostname, patterns) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) => {
    if (!pattern.startsWith("*.")) return host === pattern;
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  });
}
function invalidTarget() {
  return new PluginError("UPLOAD_TARGET_REJECTED", "\u76F4\u4F20\u76EE\u6807\u4E0D\u7B26\u5408 Quick Image \u4E0A\u4F20\u5B89\u5168\u7B56\u7565\u3002", {
    field: "direct_upload.upload_url",
    suggested_action: "\u91CD\u65B0\u8C03\u7528\u8FDC\u7A0B MCP \u83B7\u53D6\u76F4\u4F20\u4FE1\u606F\uFF1B\u4E0D\u8981\u624B\u5DE5\u4FEE\u6539 URL\u3002"
  });
}
function invalidAllowlist() {
  return new PluginError("UPLOAD_ALLOWLIST_INVALID", "\u4E0A\u4F20\u57DF\u540D\u5141\u8BB8\u5217\u8868\u914D\u7F6E\u65E0\u6548\u3002", {
    suggested_action: "\u5C06 QUICK_IMAGE_UPLOAD_HOSTS \u914D\u7F6E\u4E3A\u9017\u53F7\u5206\u9694\u7684\u5B8C\u6574\u57DF\u540D\u6216 *.example.com\u3002"
  });
}

// src/services/attachment-pipeline.ts
import { createHash as createHash5 } from "crypto";

// src/services/inspect-attachment.ts
import { createHash } from "crypto";
import path3 from "path";

// src/attachments/read-secure-file.ts
import { constants as fsConstants } from "fs";
import { lstat, open } from "fs/promises";
async function readSecureAttachmentFile(filePath) {
  const sourceDetails = await lstat(filePath);
  if (sourceDetails.isSymbolicLink() || !sourceDetails.isFile()) throw invalidFile();
  const file = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const current = await file.stat({ bigint: true });
    if (!current.isFile()) throw invalidFile();
    if (current.size > BigInt(MAX_INPUT_BYTES)) {
      throw new PluginError("ATTACHMENT_TOO_LARGE", "\u9644\u4EF6\u8D85\u8FC7\u672C\u5730\u5904\u7406\u6838\u5FC3\u7684\u6700\u5927\u8BFB\u53D6\u9650\u5236\u3002", {
        field: "size",
        current_value: Number(current.size),
        limit_value: MAX_INPUT_BYTES
      });
    }
    const before = fileIdentity(current);
    const buffer = await file.readFile();
    const after = fileIdentity(await file.stat({ bigint: true }));
    if (!sameFileIdentity(before, after) || buffer.length !== after.size) {
      throw new PluginError("ATTACHMENT_CHANGED", "\u9644\u4EF6\u5728\u8BFB\u53D6\u671F\u95F4\u53D1\u751F\u53D8\u5316\uFF0C\u5DF2\u62D2\u7EDD\u5904\u7406\u3002", {
        field: "attachment",
        suggested_action: "\u8BF7\u91CD\u65B0\u68C0\u67E5\u9644\u4EF6\u5E76\u786E\u8BA4\u6700\u65B0\u62A5\u4EF7\u3002"
      });
    }
    return { buffer, identity: after };
  } finally {
    await file.close();
  }
}
function fileIdentity(details) {
  return {
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: Number(details.size),
    modified_at_ns: details.mtimeNs.toString(),
    changed_at_ns: details.ctimeNs.toString()
  };
}
function sameFileIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.modified_at_ns === right.modified_at_ns && left.changed_at_ns === right.changed_at_ns;
}
function invalidFile() {
  return new PluginError("ATTACHMENT_NOT_REGULAR_FILE", "\u9644\u4EF6\u5FC5\u987B\u662F\u975E\u7B26\u53F7\u94FE\u63A5\u7684\u666E\u901A\u6587\u4EF6\u3002", {
    field: "path"
  });
}

// src/attachments/resolve-input-path.ts
import { lstat as lstat2 } from "fs/promises";
import os2 from "os";
import path2 from "path";
var OPENCLAW_MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
async function resolveAttachmentInputPath(input, openClawStateDirectory = defaultOpenClawStateDirectory()) {
  if (path2.isAbsolute(input)) return input;
  if (!/^media:/i.test(input)) {
    throw new PluginError("ATTACHMENT_PATH_NOT_ABSOLUTE", "\u9644\u4EF6\u8DEF\u5F84\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84\u3002", { field: "path" });
  }
  const mediaId = parseOpenClawInboundMediaId(input);
  const inboundDirectory = path2.join(openClawStateDirectory, "media", "inbound");
  try {
    const details = await lstat2(inboundDirectory);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("invalid inbound media directory");
  } catch {
    throw new PluginError("ATTACHMENT_MEDIA_STORE_UNAVAILABLE", "OpenClaw \u5165\u7AD9\u5A92\u4F53\u76EE\u5F55\u4E0D\u53EF\u7528\u3002", {
      field: "path",
      suggested_action: "\u8BF7\u786E\u8BA4\u9644\u4EF6\u6765\u81EA\u5F53\u524D OpenClaw \u4F1A\u8BDD\u540E\u91CD\u8BD5\u3002"
    });
  }
  return path2.join(inboundDirectory, mediaId);
}
function parseOpenClawInboundMediaId(input) {
  try {
    const uri = new URL(input);
    const encodedId = uri.pathname.replace(/^\/+/, "");
    const mediaId = decodeURIComponent(encodedId);
    const valid = uri.protocol === "media:" && uri.hostname === "inbound" && !uri.port && !uri.username && !uri.password && !uri.search && !uri.hash && OPENCLAW_MEDIA_ID.test(mediaId) && mediaId !== "." && mediaId !== "..";
    if (valid) return mediaId;
  } catch {
  }
  throw new PluginError("ATTACHMENT_MEDIA_URI_INVALID", "OpenClaw \u5165\u7AD9\u5A92\u4F53\u5F15\u7528\u65E0\u6548\u3002", { field: "path" });
}
function defaultOpenClawStateDirectory() {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  return configured ? path2.resolve(configured) : path2.join(os2.homedir(), ".openclaw");
}

// src/media/detect.ts
var FORMATS = {
  jpeg: { kind: "image", format: "jpeg", contentType: "image/jpeg", extension: ".jpg" },
  png: { kind: "image", format: "png", contentType: "image/png", extension: ".png" },
  webp: { kind: "image", format: "webp", contentType: "image/webp", extension: ".webp" },
  mp4: { kind: "video", format: "mp4", contentType: "video/mp4", extension: ".mp4" },
  mov: { kind: "video", format: "mov", contentType: "video/quicktime", extension: ".mov" },
  wav: { kind: "audio", format: "wav", contentType: "audio/wav", extension: ".wav" },
  mp3: { kind: "audio", format: "mp3", contentType: "audio/mpeg", extension: ".mp3" }
};
function detectMedia(buffer) {
  if (buffer.length < 12) throw unsupported();
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return FORMATS.jpeg;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return FORMATS.png;
  }
  const riff = buffer.toString("ascii", 0, 4) === "RIFF";
  if (riff && buffer.toString("ascii", 8, 12) === "WEBP") return FORMATS.webp;
  if (riff && buffer.toString("ascii", 8, 12) === "WAVE") return FORMATS.wav;
  if (buffer.toString("ascii", 0, 3) === "ID3" || isMp3FrameHeader(buffer[0], buffer[1])) return FORMATS.mp3;
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const majorBrand = buffer.toString("ascii", 8, 12).trim().toLowerCase();
    return majorBrand === "qt" ? FORMATS.mov : FORMATS.mp4;
  }
  throw unsupported();
}
function isMp3FrameHeader(first, second) {
  return first === 255 && second !== void 0 && (second & 224) === 224 && (second & 6) !== 0;
}
function unsupported() {
  return new PluginError("UNSUPPORTED_MEDIA_FORMAT", "\u53EA\u652F\u6301\u9759\u6001 JPEG\u3001PNG\u3001WebP\u3001MP4\u3001MOV\u3001WAV \u548C MP3\u3002", {
    field: "format"
  });
}

// src/media/image.ts
import sharp from "sharp";
var MIN_QUALITY = 50;
var MAX_INPUT_PIXELS = 1e8;
async function inspectImage(input, expectedFormat) {
  try {
    const metadata = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) throw invalidImage();
    if ((metadata.pages ?? 1) > 1) {
      throw new PluginError("ANIMATED_IMAGE_UNSUPPORTED", "\u53EA\u652F\u6301\u9759\u6001\u56FE\u7247\u3002", { field: "format" });
    }
    if (normalizeSharpFormat(metadata.format) !== expectedFormat) throw invalidImage();
    return { width: metadata.autoOrient.width, height: metadata.autoOrient.height };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalidImage();
  }
}
async function processImage(input, expectedFormat) {
  try {
    const source = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS });
    const sourceMetadata = await source.metadata();
    if (!sourceMetadata.width || !sourceMetadata.height || !sourceMetadata.format) throw invalidImage();
    if ((sourceMetadata.pages ?? 1) > 1) {
      throw new PluginError("ANIMATED_IMAGE_UNSUPPORTED", "\u53EA\u652F\u6301\u9759\u6001\u56FE\u7247\u3002", { field: "format" });
    }
    if (normalizeSharpFormat(sourceMetadata.format) !== expectedFormat) throw invalidImage();
    let width = sourceMetadata.autoOrient.width;
    let height = sourceMetadata.autoOrient.height;
    const edgeScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    width = Math.max(1, Math.floor(width * edgeScale));
    height = Math.max(1, Math.floor(height * edgeScale));
    let output;
    let scale = 1;
    for (let quality = 95; quality >= MIN_QUALITY; quality -= 5) {
      output = await encode(input, expectedFormat, width, height, quality, scale);
      if (output.length <= MAX_IMAGE_BYTES) break;
      if (expectedFormat === "png" || quality === MIN_QUALITY) scale *= 0.9;
    }
    while (output && output.length > MAX_IMAGE_BYTES && scale > 0.2) {
      scale *= 0.85;
      output = await encode(input, expectedFormat, width, height, MIN_QUALITY, scale);
    }
    if (!output || output.length > MAX_IMAGE_BYTES) {
      throw new PluginError("IMAGE_COMPRESSION_FAILED", "\u56FE\u7247\u538B\u7F29\u540E\u4ECD\u8D85\u8FC7 6.5 MiB\u3002", {
        field: "size",
        current_value: output?.length ?? input.length,
        limit_value: MAX_IMAGE_BYTES
      });
    }
    const finalMetadata = await sharp(output).metadata();
    if (!finalMetadata.width || !finalMetadata.height) throw invalidImage();
    return {
      buffer: output,
      metadata: { width: finalMetadata.width, height: finalMetadata.height }
    };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalidImage();
  }
}
async function encode(input, format, width, height, quality, scale) {
  const pipeline = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).autoOrient().resize({
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    fit: "inside",
    withoutEnlargement: true
  });
  switch (format) {
    case "jpeg":
      return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    case "webp":
      return pipeline.webp({ quality, effort: 6 }).toBuffer();
    case "png":
      return pipeline.png({ compressionLevel: 9, effort: 10 }).toBuffer();
    default:
      throw invalidImage();
  }
}
function normalizeSharpFormat(format) {
  if (format === "jpg" || format === "jpeg") return "jpeg";
  if (format === "png" || format === "webp") return format;
  return void 0;
}
function invalidImage() {
  return new PluginError("INVALID_IMAGE", "\u56FE\u7247\u6587\u4EF6\u635F\u574F\u6216\u65E0\u6CD5\u5B89\u5168\u89E3\u7801\u3002", { field: "attachment" });
}

// src/media/media-info.ts
import { createRequire } from "module";
import mediaInfoFactory, {
  isTrackType
} from "mediainfo.js";
var require2 = createRequire(import.meta.url);
async function inspectAudioVideo(buffer, expectedFormat) {
  const wasmPath = require2.resolve("mediainfo.js/MediaInfoModule.wasm");
  const mediaInfo = await mediaInfoFactory({ format: "object", locateFile: () => wasmPath });
  try {
    const result = await mediaInfo.analyzeData(buffer.length, (size, offset) => buffer.subarray(offset, offset + size));
    const tracks = result.media?.track ?? [];
    const general = tracks.find((track) => isTrackType(track, "General"));
    const video = tracks.find((track) => isTrackType(track, "Video"));
    const audio = tracks.find((track) => isTrackType(track, "Audio"));
    if (expectedFormat === "mp4" || expectedFormat === "mov") {
      if (!video || !isExpectedContainer(general?.Format, expectedFormat)) throw invalidMedia();
    } else if (expectedFormat !== "wav" && expectedFormat !== "mp3" || !audio || video || !isExpectedAudio(general?.Format, audio.Format, expectedFormat)) {
      throw invalidMedia();
    }
    const duration = finiteNumber(general?.Duration ?? video?.Duration ?? audio?.Duration);
    if (duration === void 0) throw invalidMedia();
    if (duration < MIN_MEDIA_DURATION_SECONDS || duration > MAX_MEDIA_DURATION_SECONDS) {
      throw new PluginError("MEDIA_DURATION_OUT_OF_RANGE", "\u97F3\u89C6\u9891\u65F6\u957F\u5FC5\u987B\u5728 2 \u5230 15 \u79D2\u4E4B\u95F4\u3002", {
        field: "duration_seconds",
        current_value: duration,
        limit_value: "2-15"
      });
    }
    return compactMetadata([
      ["duration_seconds", round(duration, 3)],
      ["width", finiteInteger(video?.Width)],
      ["height", finiteInteger(video?.Height)],
      ["frame_rate", roundOptional(finiteNumber(video?.FrameRate), 3)],
      ["audio_channels", finiteInteger(audio?.Channels)],
      ["sample_rate", finiteInteger(audio?.SamplingRate)]
    ]);
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalidMedia();
  } finally {
    mediaInfo.close();
  }
}
function isExpectedContainer(format, expected) {
  const normalized = format?.toLowerCase() ?? "";
  if (expected === "mov") return normalized.includes("quicktime") || normalized.includes("mpeg-4");
  return normalized.includes("mpeg-4") || normalized === "mp4";
}
function isExpectedAudio(generalFormat, audioFormat, expected) {
  const combined = `${generalFormat ?? ""} ${audioFormat ?? ""}`.toLowerCase();
  return expected === "wav" ? combined.includes("wave") || combined.includes("pcm") : combined.includes("mpeg audio");
}
function compactMetadata(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== void 0));
}
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function finiteInteger(value) {
  const number2 = finiteNumber(value);
  return number2 === void 0 ? void 0 : Math.round(number2);
}
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function roundOptional(value, digits) {
  return value === void 0 ? void 0 : round(value, digits);
}
function invalidMedia() {
  return new PluginError("INVALID_MEDIA", "\u97F3\u89C6\u9891\u6587\u4EF6\u635F\u574F\u3001\u683C\u5F0F\u4E0D\u5339\u914D\u6216\u65E0\u6CD5\u8BFB\u53D6\u5143\u6570\u636E\u3002", {
    field: "attachment"
  });
}

// src/services/inspect-attachment.ts
var InspectAttachmentService = class {
  constructor(store, openClawStateDirectory) {
    this.store = store;
    this.openClawStateDirectory = openClawStateDirectory;
  }
  async execute(inputPath, scopeDigest) {
    const filePath = await resolveAttachmentInputPath(inputPath, this.openClawStateDirectory);
    const source = await readSecureAttachmentFile(filePath);
    const detected = detectMedia(source.buffer);
    assertSourceSize(detected.kind, source.buffer.length);
    const metadata = detected.kind === "image" ? await inspectImage(source.buffer, detected.format) : await inspectAudioVideo(source.buffer, detected.format);
    const expiresAt = new Date(Date.now() + HANDLE_TTL_MS).toISOString();
    const sourceChecksum = `sha256:${createHash("sha256").update(source.buffer).digest("hex")}`;
    const filename = normalizeFileName(path3.basename(filePath), detected.extension);
    const attachmentHandle = await this.store.createInspection({
      record_type: "inspected",
      ...scopeDigest ? { scope_digest: scopeDigest } : {},
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
};
function assertSourceSize(kind, size) {
  const limit = kind === "video" ? MAX_VIDEO_BYTES : kind === "audio" ? MAX_AUDIO_BYTES : MAX_INPUT_BYTES;
  if (size > limit) {
    throw new PluginError("MEDIA_SIZE_EXCEEDED", "\u9644\u4EF6\u5927\u5C0F\u8D85\u8FC7\u5141\u8BB8\u8303\u56F4\u3002", {
      field: "size",
      current_value: size,
      limit_value: limit
    });
  }
  if (kind === "image" && size === 0) {
    throw new PluginError("INVALID_IMAGE", "\u56FE\u7247\u6587\u4EF6\u4E3A\u7A7A\u3002", { field: "attachment" });
  }
}
function normalizeFileName(displayName, extension) {
  const originalExtension = path3.extname(displayName);
  const stem = path3.basename(displayName, originalExtension).replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return `${(stem || "attachment").slice(0, 200)}${extension}`;
}

// src/services/prepare-attachment.ts
import { createHash as createHash2 } from "crypto";
var PrepareAttachmentService = class {
  constructor(store) {
    this.store = store;
  }
  async execute(attachmentHandle, scopeDigest) {
    return this.store.withInspection(attachmentHandle, async (record) => {
      let source;
      try {
        source = await readSecureAttachmentFile(record.source_path);
      } catch {
        throw attachmentChanged();
      }
      const input = source.buffer;
      const sourceChecksum = `sha256:${createHash2("sha256").update(input).digest("hex")}`;
      const detected = detectMedia(input);
      if (!sameFileIdentity(source.identity, record.file_identity) || input.length !== record.size || sourceChecksum !== record.source_checksum || detected.kind !== record.kind || detected.format !== record.format || detected.contentType !== record.content_type) {
        throw attachmentChanged();
      }
      let finalBuffer = input;
      let metadata;
      if (record.kind === "image") {
        const processed = await processImage(input, record.format);
        finalBuffer = processed.buffer;
        metadata = processed.metadata;
      } else {
        metadata = await inspectAudioVideo(input, record.format);
      }
      const expiresAt = new Date(Date.now() + HANDLE_TTL_MS).toISOString();
      const checksum = `sha256:${createHash2("sha256").update(finalBuffer).digest("hex")}`;
      const uploadChecksum = createHash2("md5").update(finalBuffer).digest("base64");
      const stagedHandle = await this.store.createStage(finalBuffer, {
        record_type: "staged",
        ...scopeDigest ? { scope_digest: scopeDigest } : {},
        content_type: record.content_type,
        size: finalBuffer.length,
        checksum,
        expires_at: expiresAt
      });
      return {
        staged_handle: stagedHandle,
        create_direct_upload_args: {
          filename: record.filename,
          kind: record.kind,
          content_type: record.content_type,
          byte_size: finalBuffer.length,
          checksum,
          upload_checksum: uploadChecksum,
          metadata
        },
        expires_at: expiresAt
      };
    }, scopeDigest);
  }
};
function attachmentChanged() {
  return new PluginError("ATTACHMENT_CHANGED", "\u9644\u4EF6\u5728\u62A5\u4EF7\u540E\u53D1\u751F\u53D8\u5316\u6216\u5DF2\u4E0D\u53EF\u8BFB\u53D6\uFF0C\u5DF2\u62D2\u7EDD\u5904\u7406\u3002", {
    field: "attachment_handle",
    suggested_action: "\u8BF7\u91CD\u65B0\u68C0\u67E5\u9644\u4EF6\u5E76\u786E\u8BA4\u6700\u65B0\u62A5\u4EF7\u3002"
  });
}

// src/services/upload-staged-attachment.ts
import { createHash as createHash3 } from "crypto";
import { readFile } from "fs/promises";
import https from "https";
var FORBIDDEN_HEADERS = /* @__PURE__ */ new Set(["connection", "host", "transfer-encoding", "upgrade", "proxy-authorization"]);
var UploadStagedAttachmentService = class {
  constructor(store, targetPolicy = createUploadTargetPolicy(), uploader = putBuffer) {
    this.store = store;
    this.targetPolicy = targetPolicy;
    this.uploader = uploader;
  }
  async execute(stagedHandle, directUpload, scopeDigest) {
    const uploadUrl = this.targetPolicy.assertUrl(directUpload.upload_url);
    validateDirectUpload(directUpload);
    return this.store.withStage(stagedHandle, async (record, stagedFilePath) => {
      const buffer = await readFile(stagedFilePath);
      const checksum = `sha256:${createHash3("sha256").update(buffer).digest("hex")}`;
      if (buffer.length !== record.size || checksum !== record.checksum) {
        throw new PluginError("STAGED_ATTACHMENT_CHANGED", "\u6682\u5B58\u9644\u4EF6\u5185\u5BB9\u6821\u9A8C\u5931\u8D25\uFF0C\u5DF2\u62D2\u7EDD\u4E0A\u4F20\u3002", {
          field: "staged_handle",
          suggested_action: "\u91CD\u65B0\u51C6\u5907\u5F53\u524D\u5BF9\u8BDD\u9644\u4EF6\u5E76\u83B7\u53D6\u65B0\u7684\u76F4\u4F20\u4FE1\u606F\u3002"
        });
      }
      const headers = validateHeaders(directUpload.headers, record.size, record.content_type);
      await this.uploader(uploadUrl, headers, buffer, this.targetPolicy.lookup);
      return { asset_id: directUpload.asset_id };
    }, scopeDigest);
  }
};
function validateDirectUpload(directUpload) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(directUpload.asset_id)) {
    throw new PluginError("INVALID_DIRECT_UPLOAD", "\u76F4\u4F20\u4FE1\u606F\u4E2D\u7684\u7D20\u6750\u6807\u8BC6\u65E0\u6548\u3002", {
      field: "direct_upload.asset_id"
    });
  }
  const expires = Date.parse(directUpload.expires_at);
  const now = Date.now();
  if (!Number.isFinite(expires) || expires <= now || expires > now + HANDLE_TTL_MS + 5 * 60 * 1e3) {
    throw new PluginError("DIRECT_UPLOAD_EXPIRED", "\u76F4\u4F20\u4FE1\u606F\u5DF2\u8FC7\u671F\u6216\u6709\u6548\u671F\u5F02\u5E38\u3002", {
      field: "direct_upload.expires_at",
      suggested_action: "\u91CD\u65B0\u8C03\u7528\u8FDC\u7A0B MCP \u83B7\u53D6\u76F4\u4F20\u4FE1\u606F\u3002"
    });
  }
}
function validateHeaders(input, size, contentType) {
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || FORBIDDEN_HEADERS.has(name)) {
      throw new PluginError("UPLOAD_HEADER_REJECTED", "\u76F4\u4F20\u8BF7\u6C42\u5934\u4E0D\u7B26\u5408\u5B89\u5168\u7B56\u7565\u3002", {
        field: "direct_upload.headers"
      });
    }
    if (typeof rawValue !== "string" || /[\r\n]/.test(rawValue)) {
      throw new PluginError("UPLOAD_HEADER_REJECTED", "\u76F4\u4F20\u8BF7\u6C42\u5934\u503C\u65E0\u6548\u3002", {
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
function putBuffer(url, headers, buffer, lookup) {
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
function headerMismatch(header) {
  return new PluginError("UPLOAD_METADATA_MISMATCH", "\u76F4\u4F20\u4FE1\u606F\u4E0E\u6682\u5B58\u9644\u4EF6\u5143\u6570\u636E\u4E0D\u4E00\u81F4\u3002", {
    field: `direct_upload.headers.${header}`,
    suggested_action: "\u4F7F\u7528\u51C6\u5907\u9644\u4EF6\u8FD4\u56DE\u7684\u6700\u7EC8\u5143\u6570\u636E\u91CD\u65B0\u83B7\u53D6\u76F4\u4F20\u4FE1\u606F\u3002"
  });
}
function uploadError(code, retryable) {
  return new PluginError(code, "\u9644\u4EF6\u76F4\u4F20\u672A\u5B8C\u6210\u3002", {
    retryable,
    suggested_action: retryable ? "\u4FDD\u7559\u540C\u4E00\u6682\u5B58\u53E5\u67C4\u5E76\u7A0D\u540E\u91CD\u8BD5\u3002" : "\u91CD\u65B0\u83B7\u53D6\u76F4\u4F20\u4FE1\u606F\u3002"
  });
}

// src/store/handle-store.ts
import { createHash as createHash4, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { constants as fsConstants2 } from "fs";
import {
  chmod,
  lstat as lstat3,
  mkdir,
  open as open2,
  readFile as readFile2,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "fs/promises";
import path4 from "path";
var STALE_LEASE_MS = 10 * 60 * 1e3;
function tokenDigest(token) {
  return createHash4("sha256").update(token).digest("hex");
}
function createHandle(prefix) {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}
function secureEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function assertHandle(handle, access) {
  if (!new RegExp(`^${access.prefix}[A-Za-z0-9_-]{43}$`).test(handle)) {
    throw new PluginError(access.invalidCode, "\u9644\u4EF6\u53E5\u67C4\u683C\u5F0F\u65E0\u6548\u3002", { field: access.field });
  }
}
async function writePrivateJson(filePath, value) {
  const file = await open2(filePath, fsConstants2.O_CREAT | fsConstants2.O_EXCL | fsConstants2.O_WRONLY, 384);
  try {
    await file.writeFile(`${JSON.stringify(value)}
`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
var HandleStore = class {
  root;
  inspectedRecordsDirectory;
  stagedRecordsDirectory;
  stagedFilesDirectory;
  constructor(root) {
    this.root = root;
    this.inspectedRecordsDirectory = path4.join(root, "inspected-records");
    this.stagedRecordsDirectory = path4.join(root, "staged-records");
    this.stagedFilesDirectory = path4.join(root, "staged-files");
  }
  async initialize() {
    await ensurePrivateDirectory(this.root);
    await Promise.all([
      rm(path4.join(this.root, "handles"), { recursive: true, force: true }),
      rm(path4.join(this.root, "captured-records"), { recursive: true, force: true }),
      rm(path4.join(this.root, "captured-files"), { recursive: true, force: true })
    ]);
    for (const directory of [
      this.inspectedRecordsDirectory,
      this.stagedRecordsDirectory,
      this.stagedFilesDirectory
    ]) {
      await ensurePrivateDirectory(directory);
    }
    await this.cleanupExpired();
  }
  async createInspection(record) {
    const handle = createHandle("qia_");
    const inspectedRecord = {
      ...record,
      handle_digest: tokenDigest(handle)
    };
    await writePrivateJson(
      path4.join(this.inspectedRecordsDirectory, `${inspectedRecord.handle_digest}.json`),
      inspectedRecord
    );
    return handle;
  }
  async createStage(buffer, record) {
    const handle = createHandle("qis_");
    const stagedRecord = {
      ...record,
      handle_digest: tokenDigest(handle),
      staged_file_id: randomUUID()
    };
    await this.writeRecord(
      buffer,
      stagedRecord,
      this.stagedRecordsDirectory,
      this.stagedFilesDirectory,
      stagedRecord.staged_file_id
    );
    return handle;
  }
  async withInspection(handle, action, scopeDigest) {
    return this.withRecord(handle, this.inspectedAccess(), (record) => action(record), scopeDigest);
  }
  async withStage(handle, action, scopeDigest) {
    return this.withRecord(handle, this.stagedAccess(), (record, filePath) => {
      if (!filePath) throw new Error("missing staged file path");
      return action(record, filePath);
    }, scopeDigest);
  }
  async cleanupExpired(now = /* @__PURE__ */ new Date()) {
    await Promise.all([
      this.cleanupLayout(this.inspectedAccess(), now),
      this.cleanupLayout(this.stagedAccess(), now)
    ]);
  }
  inspectedAccess() {
    return {
      prefix: "qia_",
      recordType: "inspected",
      recordDirectory: this.inspectedRecordsDirectory,
      field: "attachment_handle",
      invalidCode: "INVALID_ATTACHMENT_HANDLE",
      invalidRecordCode: "ATTACHMENT_HANDLE_INVALID",
      missingCode: "ATTACHMENT_HANDLE_NOT_FOUND",
      expiredCode: "ATTACHMENT_HANDLE_EXPIRED"
    };
  }
  stagedAccess() {
    return {
      prefix: "qis_",
      recordType: "staged",
      recordDirectory: this.stagedRecordsDirectory,
      fileDirectory: this.stagedFilesDirectory,
      fileId: (record) => record.staged_file_id,
      field: "staged_handle",
      invalidCode: "INVALID_STAGED_HANDLE",
      invalidRecordCode: "STAGED_HANDLE_INVALID",
      missingCode: "STAGED_HANDLE_NOT_FOUND",
      expiredCode: "STAGED_HANDLE_EXPIRED"
    };
  }
  async writeRecord(buffer, record, recordDirectory, fileDirectory, fileId) {
    const filePath = path4.join(fileDirectory, fileId);
    try {
      await writeFile(filePath, buffer, { flag: "wx", mode: 384 });
      await writePrivateJson(path4.join(recordDirectory, `${record.handle_digest}.json`), record);
    } catch (error) {
      await rm(filePath, { force: true });
      throw error;
    }
  }
  async withRecord(handle, access, action, scopeDigest) {
    assertHandle(handle, access);
    const claim = await this.claimRecord(access, handle);
    const filePath = access.fileDirectory && access.fileId ? path4.join(access.fileDirectory, access.fileId(claim.record)) : void 0;
    try {
      this.assertScope(claim.record, scopeDigest, access);
      this.assertNotExpired(claim.record, access);
      const result = await action(claim.record, filePath);
      await unlink(claim.leasePath);
      if (filePath) await rm(filePath, { force: true });
      return result;
    } catch (error) {
      await this.restoreClaim(claim);
      throw error;
    }
  }
  assertScope(record, scopeDigest, access) {
    const recordScope = record.scope_digest;
    const matches = recordScope === void 0 ? scopeDigest === void 0 : typeof recordScope === "string" && typeof scopeDigest === "string" && secureEqual(recordScope, scopeDigest);
    if (!matches) {
      throw new PluginError(access.missingCode, "\u9644\u4EF6\u53E5\u67C4\u4E0D\u5B58\u5728\u3001\u5DF2\u4F7F\u7528\u6216\u6B63\u5728\u4F7F\u7528\u3002", {
        field: access.field
      });
    }
  }
  async claimRecord(access, handle) {
    const digest = tokenDigest(handle);
    const originalPath = path4.join(access.recordDirectory, `${digest}.json`);
    const leasePath = `${originalPath}.lease-${randomUUID()}`;
    try {
      await rename(originalPath, leasePath);
    } catch {
      throw new PluginError(access.missingCode, "\u9644\u4EF6\u53E5\u67C4\u4E0D\u5B58\u5728\u3001\u5DF2\u4F7F\u7528\u6216\u6B63\u5728\u4F7F\u7528\u3002", {
        field: access.field
      });
    }
    try {
      const record = JSON.parse(await readFile2(leasePath, "utf8"));
      if (record.record_type !== access.recordType || !record.handle_digest || !secureEqual(record.handle_digest, digest)) {
        throw new PluginError(access.invalidRecordCode, "\u9644\u4EF6\u53E5\u67C4\u8BB0\u5F55\u6821\u9A8C\u5931\u8D25\u3002", { field: access.field });
      }
      return { record, originalPath, leasePath };
    } catch (error) {
      await rm(leasePath, { force: true });
      throw error;
    }
  }
  assertNotExpired(record, access) {
    const expiresAt = record.expires_at;
    const expires = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      throw new PluginError(access.expiredCode, "\u9644\u4EF6\u53E5\u67C4\u5DF2\u8FC7\u671F\u3002", {
        field: access.field,
        suggested_action: "\u91CD\u65B0\u68C0\u67E5\u5F53\u524D\u5BF9\u8BDD\u9644\u4EF6\u3002"
      });
    }
  }
  async restoreClaim(claim) {
    try {
      await rename(claim.leasePath, claim.originalPath);
    } catch {
      await rm(claim.leasePath, { force: true });
    }
  }
  async cleanupLayout(access, now) {
    const activeFileIds = await this.cleanupRecordDirectory(access, now);
    if (!access.fileDirectory) return;
    const entries = await readdir(access.fileDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || activeFileIds.has(entry.name)) continue;
      const filePath = path4.join(access.fileDirectory, entry.name);
      const details = await stat(filePath);
      if (now.getTime() - details.mtimeMs >= HANDLE_TTL_MS) await rm(filePath, { force: true });
    }
  }
  async cleanupRecordDirectory(access, now) {
    const activeFileIds = /* @__PURE__ */ new Set();
    const entries = await readdir(access.recordDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.includes(".json")) continue;
      let filePath = path4.join(access.recordDirectory, entry.name);
      try {
        const record = JSON.parse(await readFile2(filePath, "utf8"));
        if (record.record_type !== access.recordType) throw new Error("unexpected attachment record type");
        const fileId = access.fileId?.(record);
        if (access.fileDirectory && !fileId) throw new Error("missing attachment file id");
        const leaseMarker = entry.name.indexOf(".json.lease-");
        if (leaseMarker !== -1) {
          const leaseDetails = await stat(filePath);
          if (now.getTime() - leaseDetails.mtimeMs < STALE_LEASE_MS) {
            if (fileId) activeFileIds.add(fileId);
            continue;
          }
          const originalPath = path4.join(access.recordDirectory, entry.name.slice(0, leaseMarker + 5));
          try {
            await rename(filePath, originalPath);
            filePath = originalPath;
          } catch {
            await rm(filePath, { force: true });
            if (fileId) activeFileIds.add(fileId);
            continue;
          }
        }
        const expires = Date.parse(record.expires_at ?? "");
        if (!Number.isFinite(expires) || expires <= now.getTime()) {
          await rm(filePath, { force: true });
          if (access.fileDirectory && fileId) await rm(path4.join(access.fileDirectory, fileId), { force: true });
          continue;
        }
        if (fileId) activeFileIds.add(fileId);
      } catch {
        await rm(filePath, { force: true });
      }
    }
    return activeFileIds;
  }
};
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
  const details = await lstat3(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new PluginError("INSECURE_STATE_DIRECTORY", "\u672C\u5730\u9644\u4EF6\u5904\u7406\u72B6\u6001\u76EE\u5F55\u4E0D\u5B89\u5168\u3002", {
      suggested_action: "\u5C06 QUICK_IMAGE_DATA_DIR \u6307\u5411\u4EC5\u5F53\u524D\u7528\u6237\u53EF\u8BBF\u95EE\u7684\u771F\u5B9E\u76EE\u5F55\u3002"
    });
  }
  if ((details.mode & 63) !== 0) await chmod(directory, 448);
}

// src/services/attachment-pipeline.ts
var AttachmentPipeline = class _AttachmentPipeline {
  constructor(store, inspectAttachment, prepareAttachment, uploadAttachment) {
    this.store = store;
    this.inspectAttachment = inspectAttachment;
    this.prepareAttachment = prepareAttachment;
    this.uploadAttachment = uploadAttachment;
  }
  static async create(stateDirectory) {
    const store = new HandleStore(stateDirectory);
    await store.initialize();
    return new _AttachmentPipeline(
      store,
      new InspectAttachmentService(store),
      new PrepareAttachmentService(store),
      new UploadStagedAttachmentService(store)
    );
  }
  inspect(sourceReference, scope) {
    return this.inspectAttachment.execute(sourceReference, digestScope(scope));
  }
  prepare(attachmentHandle, scope) {
    return this.prepareAttachment.execute(attachmentHandle, digestScope(scope));
  }
  upload(stagedHandle, directUpload, scope) {
    return this.uploadAttachment.execute(stagedHandle, directUpload, digestScope(scope));
  }
  cleanupExpired() {
    return this.store.cleanupExpired();
  }
};
function digestScope(scope) {
  return scope === void 0 ? void 0 : createHash5("sha256").update(scope).digest("hex");
}
export {
  AttachmentPipeline,
  BILLING_STRATEGIES,
  DEFAULT_UPLOAD_HOST_PATTERNS,
  HANDLE_CLEANUP_INTERVAL_MS,
  HANDLE_TTL_MS,
  HandleStore,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_INPUT_BYTES,
  MAX_MEDIA_DURATION_SECONDS,
  MAX_VIDEO_BYTES,
  MIN_MEDIA_DURATION_SECONDS,
  PluginError,
  RUNTIME_VERSION,
  UPLOAD_TIMEOUT_MS,
  assertRuntimeDependencies,
  assertSupportedRuntime,
  configuredHostPatterns,
  createDirectUploadArgumentsSchema,
  createUploadTargetPolicy,
  directUploadSchema,
  estimateGenerationCredits,
  estimateOutputSchema,
  inspectedOutputSchema,
  isPublicAddress,
  lookbookEstimateInputSchema,
  mediaMetadataSchema,
  poseEstimateInputSchema,
  preparedOutputSchema,
  resolveDataDirectory,
  resolveOpenClawAttachmentRegistryDirectory,
  toPluginError,
  upscaleEstimateInputSchema,
  videoEstimateInputSchema
};
