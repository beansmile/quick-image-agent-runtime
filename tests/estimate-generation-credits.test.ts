import { describe, expect, it } from "vitest";
import {
  estimateGenerationCredits,
  type EstimateGenerationCreditsInput
} from "../src/pricing/estimate-generation-credits.js";

const thresholds = { output_count: 8, image_credits: 200, video_credits: 500 };

const cases: Array<{
  name: string;
  input: EstimateGenerationCreditsInput;
  expected: {
    credits: number;
    outputCount: number;
    billableUnits: number;
    rounding: "none" | "ceil";
  };
}> = [
  {
    name: "搭配出图按输出数量计费",
    input: request(
      { billing_strategy: "output_count", unit_credits: 10 },
      { output_count: 3 }
    ),
    expected: { credits: 30, outputCount: 3, billableUnits: 3, rounding: "none" }
  },
  {
    name: "换姿按人物数乘单人输出数计费",
    input: request(
      { billing_strategy: "person_output_count", unit_credits: 4 },
      { person_count: 2, output_count_per_person: 3 }
    ),
    expected: { credits: 24, outputCount: 6, billableUnits: 6, rounding: "none" }
  },
  {
    name: "高清按输入数量计费",
    input: request(
      { billing_strategy: "input_count", unit_credits: 6 },
      { input_count: 4 }
    ),
    expected: { credits: 24, outputCount: 4, billableUnits: 4, rounding: "none" }
  },
  {
    name: "视频按输出时长计费并向上取整",
    input: request(
      { billing_strategy: "output_duration", credits_per_second: 8.1, rounding: "ceil" },
      { output_duration_seconds: 5 }
    ),
    expected: { credits: 41, outputCount: 1, billableUnits: 5, rounding: "ceil" }
  },
  {
    name: "视频小数乘法接近整数时不因浮点误差多收积分",
    input: request(
      { billing_strategy: "output_duration", credits_per_second: 0.6, rounding: "ceil" },
      { output_duration_seconds: 15 }
    ),
    expected: { credits: 9, outputCount: 1, billableUnits: 15, rounding: "ceil" }
  },
  {
    name: "视频按输入和输出总时长计费",
    input: request(
      { billing_strategy: "input_plus_output_duration", credits_per_second: 16, rounding: "ceil" },
      { input_video_duration_seconds: 2.25, output_duration_seconds: 5 }
    ),
    expected: { credits: 116, outputCount: 1, billableUnits: 7.25, rounding: "ceil" }
  }
];

describe("estimateGenerationCredits", () => {
  it.each(cases)("$name", ({ input, expected }) => {
    const result = estimateGenerationCredits(input);

    expect(result.estimated_credits).toBe(expected.credits);
    expect(result.estimated_output_count).toBe(expected.outputCount);
    expect(result.calculation.billable_units).toBe(expected.billableUnits);
    expect(result.calculation.rounding).toBe(expected.rounding);
  });

  it("返回命中的输出数和图片积分确认原因", () => {
    const result = estimateGenerationCredits(request(
      { billing_strategy: "person_output_count", unit_credits: 25 },
      { person_count: 2, output_count_per_person: 4 }
    ));

    expect(result.confirmation_reasons).toEqual([
      "output_count_threshold",
      "image_credits_threshold"
    ]);
  });

  it("返回命中的视频积分确认原因", () => {
    const result = estimateGenerationCredits(request(
      { billing_strategy: "output_duration", credits_per_second: 100, rounding: "ceil" },
      { output_duration_seconds: 5 }
    ));

    expect(result.confirmation_reasons).toEqual(["video_credits_threshold"]);
  });

  it("缺少计费策略需要的测量值时拒绝预估", () => {
    expect(() => estimateGenerationCredits(request(
      { billing_strategy: "input_plus_output_duration", credits_per_second: 16, rounding: "ceil" },
      { output_duration_seconds: 5 }
    ))).toThrowError(expect.objectContaining({ code: "ESTIMATE_INPUT_INVALID" }));
  });

  it("预设缺少 unit_credits 字段时拒绝预估", () => {
    expect(() => estimateGenerationCredits(imageRequest({
      preset: { billing_strategy: "output_count" },
      preset_price_behavior: "override_model"
    }))).toThrowError(expect.objectContaining({
      code: "ESTIMATE_INPUT_INVALID",
      details: expect.objectContaining({ field: "preset.unit_credits" })
    }));
  });

  it("预设 unit_credits 为 null 时使用模型价格", () => {
    const result = estimateGenerationCredits(imageRequest({
      preset: { billing_strategy: "output_count", unit_credits: null },
      preset_price_behavior: "override_model"
    }));

    expect(result.estimated_credits).toBe(20);
    expect(result.calculation.rate).toBe(10);
  });

  it("预设价格覆盖模型价格时由函数选择预设价格", () => {
    const result = estimateGenerationCredits(imageRequest({
      preset: { billing_strategy: "output_count", unit_credits: 17 },
      preset_price_behavior: "override_model"
    }));

    expect(result.estimated_credits).toBe(34);
    expect(result.calculation.rate).toBe(17);
  });

  it("模型要求忽略预设价格时使用模型价格", () => {
    const result = estimateGenerationCredits(imageRequest({
      preset: { billing_strategy: "output_count", unit_credits: 17 },
      preset_price_behavior: "use_model"
    }));

    expect(result.estimated_credits).toBe(20);
    expect(result.calculation.rate).toBe(10);
  });

  it.each([0, -1])("预设 unit_credits=%s 时拒绝预估", (unitCredits) => {
    expect(() => estimateGenerationCredits(imageRequest({
      preset: { billing_strategy: "output_count", unit_credits: unitCredits },
      preset_price_behavior: "override_model"
    }))).toThrowError(expect.objectContaining({
      code: "ESTIMATE_INPUT_INVALID",
      details: expect.objectContaining({ field: "preset.unit_credits" })
    }));
  });

  it("带价格的预设缺少价格行为时拒绝预估", () => {
    expect(() => estimateGenerationCredits(imageRequest({
      preset: { billing_strategy: "output_count", unit_credits: 17 }
    }))).toThrowError(expect.objectContaining({
      code: "ESTIMATE_INPUT_INVALID",
      details: expect.objectContaining({ field: "preset_price_behavior" })
    }));
  });
});

function imageRequest(
  selection: Record<string, unknown>
): EstimateGenerationCreditsInput {
  return {
    ...request(
      { billing_strategy: "output_count", unit_credits: 10 },
      { output_count: 2 }
    ),
    ...selection
  } as EstimateGenerationCreditsInput;
}

function request(
  pricing: EstimateGenerationCreditsInput["pricing"],
  measurements: EstimateGenerationCreditsInput["measurements"]
): EstimateGenerationCreditsInput {
  return {
    estimation_contract_version: 1,
    pricing,
    measurements,
    confirmation_thresholds: thresholds
  };
}
