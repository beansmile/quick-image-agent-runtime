import { PluginError } from "../errors.js";

export const BILLING_STRATEGIES = [
  "output_count",
  "person_output_count",
  "input_count",
  "output_duration",
  "input_plus_output_duration"
] as const;

export type BillingStrategy = (typeof BILLING_STRATEGIES)[number];
export type ImageBillingStrategy = "output_count" | "person_output_count";
export type PresetPriceBehavior = "override_model" | "use_model";
export type ConfirmationReason =
  | "output_count_threshold"
  | "image_credits_threshold"
  | "video_credits_threshold";

export type UnitPricingPlan = {
  billing_strategy: ImageBillingStrategy | "input_count";
  unit_credits: number;
};

export type PricingPlan =
  | UnitPricingPlan
  | {
      billing_strategy: "output_duration" | "input_plus_output_duration";
      credits_per_second: number;
      rounding: "ceil";
    };

export interface PresetPricingCandidate {
  billing_strategy: ImageBillingStrategy;
  unit_credits: number | null;
  [key: string]: unknown;
}

export interface EstimateMeasurements {
  input_count?: number | undefined;
  person_count?: number | undefined;
  output_count?: number | undefined;
  output_count_per_person?: number | undefined;
  output_duration_seconds?: number | undefined;
  input_video_duration_seconds?: number | undefined;
}

export interface ConfirmationThresholds {
  output_count: number;
  image_credits: number;
  video_credits: number;
}

export interface EstimateGenerationCreditsInput {
  estimation_contract_version: 1;
  pricing: PricingPlan;
  preset?: PresetPricingCandidate | null | undefined;
  preset_price_behavior?: PresetPriceBehavior | undefined;
  measurements: EstimateMeasurements;
  confirmation_thresholds: ConfirmationThresholds;
}

export interface EstimateGenerationCreditsResult {
  estimated_credits: number;
  estimated_output_count: number;
  confirmation_reasons: ConfirmationReason[];
  calculation: {
    billing_strategy: BillingStrategy;
    rate: number;
    billable_units: number;
    unrounded_credits: number;
    rounding: "none" | "ceil";
  };
}

interface BillingFactors {
  rate: number;
  billableUnits: number;
  outputCount: number;
  rounding: "none" | "ceil";
  mediaKind: "image" | "video";
}

export function estimateGenerationCredits(
  input: EstimateGenerationCreditsInput
): EstimateGenerationCreditsResult {
  if (input.estimation_contract_version !== 1) {
    throw invalidEstimate("不支持当前本地报价契约版本。");
  }
  const pricing = resolveEffectivePricing(input);
  const factors = resolveBillingFactors(pricing, input.measurements);
  validateThresholds(input.confirmation_thresholds);

  const unroundedCredits = factors.rate * factors.billableUnits;
  const estimatedCredits = factors.rounding === "ceil" ? stableCeil(unroundedCredits) : unroundedCredits;
  if (!Number.isSafeInteger(estimatedCredits) || estimatedCredits <= 0) {
    throw invalidEstimate("预计积分不是有限正整数。");
  }

  const confirmationReasons: ConfirmationReason[] = [];
  if (factors.outputCount >= input.confirmation_thresholds.output_count) {
    confirmationReasons.push("output_count_threshold");
  }
  const creditsThreshold = factors.mediaKind === "video"
    ? input.confirmation_thresholds.video_credits
    : input.confirmation_thresholds.image_credits;
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

function resolveEffectivePricing(input: EstimateGenerationCreditsInput): PricingPlan {
  const preset = input.preset;
  if (!preset) return input.pricing;
  if (preset.unit_credits === null) return input.pricing;

  // Keep price-source selection deterministic so host models only pass public config candidates.
  const unitCredits = requirePositiveInteger(preset.unit_credits, "preset.unit_credits");
  if (!input.preset_price_behavior) {
    throw invalidEstimate("带价格的预设缺少价格选择行为。", "preset_price_behavior");
  }
  if (input.preset_price_behavior === "use_model") return input.pricing;

  if (!isImagePricingPlan(input.pricing)) {
    throw invalidEstimate("预设价格只能用于搭配或换姿图片计费。", "pricing.billing_strategy");
  }
  if (preset.billing_strategy !== input.pricing.billing_strategy) {
    throw invalidEstimate("预设与模型价格的计费策略不一致。", "preset.billing_strategy");
  }

  return { billing_strategy: preset.billing_strategy, unit_credits: unitCredits };
}

function isImagePricingPlan(pricing: PricingPlan): pricing is UnitPricingPlan & {
  billing_strategy: ImageBillingStrategy;
} {
  return pricing.billing_strategy === "output_count" || pricing.billing_strategy === "person_output_count";
}

function resolveBillingFactors(pricing: PricingPlan, measurements: EstimateMeasurements): BillingFactors {
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

function unitFactors(unitCredits: number, quantity: number): BillingFactors {
  return {
    rate: requirePositiveInteger(unitCredits, "unit_credits"),
    billableUnits: quantity,
    outputCount: quantity,
    rounding: "none",
    mediaKind: "image"
  };
}

function durationFactors(creditsPerSecond: number, seconds: number): BillingFactors {
  return {
    rate: requirePositiveNumber(creditsPerSecond, "credits_per_second"),
    billableUnits: seconds,
    outputCount: 1,
    rounding: "ceil",
    mediaKind: "video"
  };
}

function stableCeil(value: number): number {
  const nearestInteger = Math.round(value);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
  return Math.abs(value - nearestInteger) <= floatingPointTolerance ? nearestInteger : Math.ceil(value);
}

function validateThresholds(thresholds: ConfirmationThresholds): void {
  requirePositiveInteger(thresholds.output_count, "confirmation_thresholds.output_count");
  requirePositiveInteger(thresholds.image_credits, "confirmation_thresholds.image_credits");
  requirePositiveInteger(thresholds.video_credits, "confirmation_thresholds.video_credits");
}

function requirePositiveInteger(value: number | undefined, field: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw invalidEstimate(`报价字段 ${field} 必须是正整数。`, field);
  }
  return value as number;
}

function requirePositiveNumber(value: number | undefined, field: string): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    throw invalidEstimate(`报价字段 ${field} 必须是有限正数。`, field);
  }
  return value as number;
}

function invalidEstimate(message: string, field?: string): PluginError {
  return new PluginError("ESTIMATE_INPUT_INVALID", message, {
    ...(field ? { field } : {}),
    retryable: false,
    suggested_action: "重新读取生成配置和附件元数据后再预估。"
  });
}
