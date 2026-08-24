import { z } from "zod";
import * as z4 from "zod/v4";

export const mediaMetadataSchema = z.object({
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  duration_seconds: z.number().positive().optional(),
  frame_rate: z.number().positive().optional(),
  audio_channels: z.number().int().positive().optional(),
  sample_rate: z.number().int().positive().optional()
});

export const createDirectUploadArgumentsSchema = z.object({
  filename: z.string().min(1).max(255),
  kind: z.enum(["image", "video", "audio"]),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  upload_checksum: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  metadata: mediaMetadataSchema
});

export const preparedOutputSchema = z.object({
  staged_handle: z.string(),
  create_direct_upload_args: createDirectUploadArgumentsSchema,
  expires_at: z.string().datetime()
});

export const inspectedOutputSchema = z.object({
  attachment_handle: z.string(),
  kind: z.enum(["image", "video", "audio"]),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  metadata: mediaMetadataSchema,
  expires_at: z.string().datetime()
});

export const directUploadSchema = z.object({
  asset_id: z.string().min(1).max(200),
  upload_url: z.string().url().max(8192),
  headers: z.record(z.string()),
  expires_at: z.string().datetime({ offset: true })
});

const confirmationThresholdsSchema = z4.object({
  output_count: z4.number().int().positive(),
  image_credits: z4.number().int().positive(),
  video_credits: z4.number().int().positive()
});

const estimationBaseShape = {
  estimation_contract_version: z4.literal(1).describe("get_generation_config 返回的本地估价契约版本"),
  confirmation_thresholds: confirmationThresholdsSchema.describe("get_generation_config 返回的完整确认阈值")
};

const lookbookPricingSchema = z4.object({
  billing_strategy: z4.literal("output_count"),
  unit_credits: z4.number().int().positive()
}).strict();

const posePricingSchema = z4.object({
  billing_strategy: z4.literal("person_output_count"),
  unit_credits: z4.number().int().positive()
}).strict();

const upscalePricingSchema = z4.object({
  billing_strategy: z4.literal("input_count"),
  unit_credits: z4.number().int().positive()
}).strict();

const videoPricingSchema = z4.discriminatedUnion("billing_strategy", [
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

function presetPricingCandidateSchema(billingStrategy: "output_count" | "person_output_count") {
  return z4.object({
    billing_strategy: z4.literal(billingStrategy),
    unit_credits: nullableIntegerSchema("预设单价；为 null 时使用模型价格")
  }).passthrough();
}

export const lookbookEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: lookbookPricingSchema.describe("所选搭配模型与分辨率的完整价格项"),
  preset: presetPricingCandidateSchema("output_count").nullable().describe("所选搭配预设完整对象；未选择预设时传 null"),
  preset_price_behavior: z4.enum(["override_model", "use_model"]).describe("所选搭配模型返回的预设价格行为"),
  output_count: z4.number().int().positive().describe("本次搭配输出图片数量")
}).strict();

export const poseEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: posePricingSchema.describe("所选换姿模型与分辨率的完整价格项"),
  preset: presetPricingCandidateSchema("person_output_count").nullable().describe("所选换姿预设完整对象；未选择预设时传 null"),
  preset_price_behavior: z4.enum(["override_model", "use_model"]).describe("所选换姿模型返回的预设价格行为"),
  person_count: z4.number().int().positive().describe("本次换姿输入人物图片数量"),
  output_count_per_person: z4.number().int().positive().describe("每个人物生成的图片数量")
}).strict();

export const upscaleEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: upscalePricingSchema.describe("当前配置返回的完整高清价格项"),
  input_count: z4.number().int().positive().describe("本次高清输入图片数量")
}).strict();

export const videoEstimateInputSchema = z4.object({
  ...estimationBaseShape,
  pricing: videoPricingSchema.describe("所选视频模型、分辨率和输入条件对应的完整价格项"),
  output_duration_seconds: z4.number().positive().describe("本次生成视频的输出总时长"),
  input_video_duration_seconds: nullablePositiveNumberSchema(
    "inspect_attachment 返回的输入视频总时长；没有视频输入时传 null"
  )
}).strict();

export const estimateOutputSchema = z.object({
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

function nullableIntegerSchema(description: string) {
  const schema = z4.union([z4.number().int(), z4.null()]).describe(description);
  // OpenClaw 2026.6 coerces anyOf branches in order and turns null into numeric zero.
  schema._zod.toJSONSchema = () => ({ type: ["integer", "null"] });
  return schema;
}

function nullablePositiveNumberSchema(description: string) {
  const schema = z4.union([z4.number().positive(), z4.null()]).describe(description);
  schema._zod.toJSONSchema = () => ({ type: ["number", "null"], exclusiveMinimum: 0 });
  return schema;
}
