import { z } from 'zod';
import * as z4 from 'zod/v4';
import { LookupFunction } from 'node:net';

declare const RUNTIME_VERSION: string;
declare const HANDLE_TTL_MS: number;
declare const HANDLE_CLEANUP_INTERVAL_MS: number;
declare const MAX_IMAGE_BYTES: number;
declare const MAX_VIDEO_BYTES: number;
declare const MAX_AUDIO_BYTES: number;
declare const MAX_INPUT_BYTES: number;
declare const MAX_IMAGE_EDGE = 3072;
declare const MIN_MEDIA_DURATION_SECONDS = 2;
declare const MAX_MEDIA_DURATION_SECONDS = 15;
declare const UPLOAD_TIMEOUT_MS: number;
declare const DEFAULT_UPLOAD_HOST_PATTERNS: string[];

declare const mediaMetadataSchema: z.ZodObject<{
    width: z.ZodOptional<z.ZodNumber>;
    height: z.ZodOptional<z.ZodNumber>;
    duration_seconds: z.ZodOptional<z.ZodNumber>;
    frame_rate: z.ZodOptional<z.ZodNumber>;
    audio_channels: z.ZodOptional<z.ZodNumber>;
    sample_rate: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    width?: number | undefined;
    height?: number | undefined;
    duration_seconds?: number | undefined;
    frame_rate?: number | undefined;
    audio_channels?: number | undefined;
    sample_rate?: number | undefined;
}, {
    width?: number | undefined;
    height?: number | undefined;
    duration_seconds?: number | undefined;
    frame_rate?: number | undefined;
    audio_channels?: number | undefined;
    sample_rate?: number | undefined;
}>;
declare const createDirectUploadArgumentsSchema: z.ZodObject<{
    filename: z.ZodString;
    kind: z.ZodEnum<["image", "video", "audio"]>;
    content_type: z.ZodString;
    byte_size: z.ZodNumber;
    checksum: z.ZodString;
    upload_checksum: z.ZodString;
    metadata: z.ZodObject<{
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        duration_seconds: z.ZodOptional<z.ZodNumber>;
        frame_rate: z.ZodOptional<z.ZodNumber>;
        audio_channels: z.ZodOptional<z.ZodNumber>;
        sample_rate: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    }, {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    filename: string;
    kind: "image" | "video" | "audio";
    content_type: string;
    byte_size: number;
    checksum: string;
    upload_checksum: string;
    metadata: {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    };
}, {
    filename: string;
    kind: "image" | "video" | "audio";
    content_type: string;
    byte_size: number;
    checksum: string;
    upload_checksum: string;
    metadata: {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    };
}>;
declare const preparedOutputSchema: z.ZodObject<{
    staged_handle: z.ZodString;
    create_direct_upload_args: z.ZodObject<{
        filename: z.ZodString;
        kind: z.ZodEnum<["image", "video", "audio"]>;
        content_type: z.ZodString;
        byte_size: z.ZodNumber;
        checksum: z.ZodString;
        upload_checksum: z.ZodString;
        metadata: z.ZodObject<{
            width: z.ZodOptional<z.ZodNumber>;
            height: z.ZodOptional<z.ZodNumber>;
            duration_seconds: z.ZodOptional<z.ZodNumber>;
            frame_rate: z.ZodOptional<z.ZodNumber>;
            audio_channels: z.ZodOptional<z.ZodNumber>;
            sample_rate: z.ZodOptional<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            width?: number | undefined;
            height?: number | undefined;
            duration_seconds?: number | undefined;
            frame_rate?: number | undefined;
            audio_channels?: number | undefined;
            sample_rate?: number | undefined;
        }, {
            width?: number | undefined;
            height?: number | undefined;
            duration_seconds?: number | undefined;
            frame_rate?: number | undefined;
            audio_channels?: number | undefined;
            sample_rate?: number | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        filename: string;
        kind: "image" | "video" | "audio";
        content_type: string;
        byte_size: number;
        checksum: string;
        upload_checksum: string;
        metadata: {
            width?: number | undefined;
            height?: number | undefined;
            duration_seconds?: number | undefined;
            frame_rate?: number | undefined;
            audio_channels?: number | undefined;
            sample_rate?: number | undefined;
        };
    }, {
        filename: string;
        kind: "image" | "video" | "audio";
        content_type: string;
        byte_size: number;
        checksum: string;
        upload_checksum: string;
        metadata: {
            width?: number | undefined;
            height?: number | undefined;
            duration_seconds?: number | undefined;
            frame_rate?: number | undefined;
            audio_channels?: number | undefined;
            sample_rate?: number | undefined;
        };
    }>;
    expires_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    staged_handle: string;
    create_direct_upload_args: {
        filename: string;
        kind: "image" | "video" | "audio";
        content_type: string;
        byte_size: number;
        checksum: string;
        upload_checksum: string;
        metadata: {
            width?: number | undefined;
            height?: number | undefined;
            duration_seconds?: number | undefined;
            frame_rate?: number | undefined;
            audio_channels?: number | undefined;
            sample_rate?: number | undefined;
        };
    };
    expires_at: string;
}, {
    staged_handle: string;
    create_direct_upload_args: {
        filename: string;
        kind: "image" | "video" | "audio";
        content_type: string;
        byte_size: number;
        checksum: string;
        upload_checksum: string;
        metadata: {
            width?: number | undefined;
            height?: number | undefined;
            duration_seconds?: number | undefined;
            frame_rate?: number | undefined;
            audio_channels?: number | undefined;
            sample_rate?: number | undefined;
        };
    };
    expires_at: string;
}>;
declare const inspectedOutputSchema: z.ZodObject<{
    attachment_handle: z.ZodString;
    kind: z.ZodEnum<["image", "video", "audio"]>;
    content_type: z.ZodString;
    byte_size: z.ZodNumber;
    metadata: z.ZodObject<{
        width: z.ZodOptional<z.ZodNumber>;
        height: z.ZodOptional<z.ZodNumber>;
        duration_seconds: z.ZodOptional<z.ZodNumber>;
        frame_rate: z.ZodOptional<z.ZodNumber>;
        audio_channels: z.ZodOptional<z.ZodNumber>;
        sample_rate: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    }, {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    }>;
    expires_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    kind: "image" | "video" | "audio";
    content_type: string;
    byte_size: number;
    metadata: {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    };
    expires_at: string;
    attachment_handle: string;
}, {
    kind: "image" | "video" | "audio";
    content_type: string;
    byte_size: number;
    metadata: {
        width?: number | undefined;
        height?: number | undefined;
        duration_seconds?: number | undefined;
        frame_rate?: number | undefined;
        audio_channels?: number | undefined;
        sample_rate?: number | undefined;
    };
    expires_at: string;
    attachment_handle: string;
}>;
declare const directUploadSchema: z.ZodObject<{
    asset_id: z.ZodString;
    upload_url: z.ZodString;
    headers: z.ZodRecord<z.ZodString, z.ZodString>;
    expires_at: z.ZodString;
}, "strip", z.ZodTypeAny, {
    expires_at: string;
    asset_id: string;
    upload_url: string;
    headers: Record<string, string>;
}, {
    expires_at: string;
    asset_id: string;
    upload_url: string;
    headers: Record<string, string>;
}>;
declare const lookbookEstimateInputSchema: z4.ZodObject<{
    pricing: z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"output_count">;
        unit_credits: z4.ZodNumber;
    }, z4.core.$strict>;
    preset: z4.ZodNullable<z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"output_count" | "person_output_count">;
        unit_credits: z4.ZodUnion<readonly [z4.ZodNumber, z4.ZodNull]>;
    }, z4.core.$loose>>;
    preset_price_behavior: z4.ZodEnum<{
        override_model: "override_model";
        use_model: "use_model";
    }>;
    output_count: z4.ZodNumber;
    estimation_contract_version: z4.ZodLiteral<1>;
    confirmation_thresholds: z4.ZodObject<{
        output_count: z4.ZodNumber;
        image_credits: z4.ZodNumber;
        video_credits: z4.ZodNumber;
    }, z4.core.$strip>;
}, z4.core.$strict>;
declare const poseEstimateInputSchema: z4.ZodObject<{
    pricing: z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"person_output_count">;
        unit_credits: z4.ZodNumber;
    }, z4.core.$strict>;
    preset: z4.ZodNullable<z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"output_count" | "person_output_count">;
        unit_credits: z4.ZodUnion<readonly [z4.ZodNumber, z4.ZodNull]>;
    }, z4.core.$loose>>;
    preset_price_behavior: z4.ZodEnum<{
        override_model: "override_model";
        use_model: "use_model";
    }>;
    person_count: z4.ZodNumber;
    output_count_per_person: z4.ZodNumber;
    estimation_contract_version: z4.ZodLiteral<1>;
    confirmation_thresholds: z4.ZodObject<{
        output_count: z4.ZodNumber;
        image_credits: z4.ZodNumber;
        video_credits: z4.ZodNumber;
    }, z4.core.$strip>;
}, z4.core.$strict>;
declare const upscaleEstimateInputSchema: z4.ZodObject<{
    pricing: z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"input_count">;
        unit_credits: z4.ZodNumber;
    }, z4.core.$strict>;
    input_count: z4.ZodNumber;
    estimation_contract_version: z4.ZodLiteral<1>;
    confirmation_thresholds: z4.ZodObject<{
        output_count: z4.ZodNumber;
        image_credits: z4.ZodNumber;
        video_credits: z4.ZodNumber;
    }, z4.core.$strip>;
}, z4.core.$strict>;
declare const videoEstimateInputSchema: z4.ZodObject<{
    pricing: z4.ZodDiscriminatedUnion<[z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"output_duration">;
        credits_per_second: z4.ZodNumber;
        rounding: z4.ZodLiteral<"ceil">;
    }, z4.core.$strict>, z4.ZodObject<{
        billing_strategy: z4.ZodLiteral<"input_plus_output_duration">;
        credits_per_second: z4.ZodNumber;
        rounding: z4.ZodLiteral<"ceil">;
    }, z4.core.$strict>]>;
    output_duration_seconds: z4.ZodNumber;
    input_video_duration_seconds: z4.ZodUnion<readonly [z4.ZodNumber, z4.ZodNull]>;
    estimation_contract_version: z4.ZodLiteral<1>;
    confirmation_thresholds: z4.ZodObject<{
        output_count: z4.ZodNumber;
        image_credits: z4.ZodNumber;
        video_credits: z4.ZodNumber;
    }, z4.core.$strip>;
}, z4.core.$strict>;
declare const estimateOutputSchema: z.ZodObject<{
    estimated_credits: z.ZodNumber;
    estimated_output_count: z.ZodNumber;
    confirmation_reasons: z.ZodArray<z.ZodEnum<["output_count_threshold", "image_credits_threshold", "video_credits_threshold"]>, "many">;
    calculation: z.ZodObject<{
        billing_strategy: z.ZodEnum<["output_count", "person_output_count", "input_count", "output_duration", "input_plus_output_duration"]>;
        rate: z.ZodNumber;
        billable_units: z.ZodNumber;
        unrounded_credits: z.ZodNumber;
        rounding: z.ZodEnum<["none", "ceil"]>;
    }, "strip", z.ZodTypeAny, {
        billing_strategy: "output_count" | "person_output_count" | "input_count" | "output_duration" | "input_plus_output_duration";
        rounding: "ceil" | "none";
        rate: number;
        billable_units: number;
        unrounded_credits: number;
    }, {
        billing_strategy: "output_count" | "person_output_count" | "input_count" | "output_duration" | "input_plus_output_duration";
        rounding: "ceil" | "none";
        rate: number;
        billable_units: number;
        unrounded_credits: number;
    }>;
}, "strip", z.ZodTypeAny, {
    estimated_credits: number;
    estimated_output_count: number;
    confirmation_reasons: ("output_count_threshold" | "image_credits_threshold" | "video_credits_threshold")[];
    calculation: {
        billing_strategy: "output_count" | "person_output_count" | "input_count" | "output_duration" | "input_plus_output_duration";
        rounding: "ceil" | "none";
        rate: number;
        billable_units: number;
        unrounded_credits: number;
    };
}, {
    estimated_credits: number;
    estimated_output_count: number;
    confirmation_reasons: ("output_count_threshold" | "image_credits_threshold" | "video_credits_threshold")[];
    calculation: {
        billing_strategy: "output_count" | "person_output_count" | "input_count" | "output_duration" | "input_plus_output_duration";
        rounding: "ceil" | "none";
        rate: number;
        billable_units: number;
        unrounded_credits: number;
    };
}>;

interface PublicErrorDetails {
    field?: string;
    current_value?: string | number;
    limit_value?: string | number;
    retryable?: boolean;
    suggested_action?: string;
}
declare class PluginError extends Error {
    readonly code: string;
    readonly details: PublicErrorDetails;
    constructor(code: string, message: string, details?: PublicErrorDetails);
    toPublicObject(): Record<string, unknown>;
}
declare function toPluginError(error: unknown): PluginError;

declare const BILLING_STRATEGIES: readonly ["output_count", "person_output_count", "input_count", "output_duration", "input_plus_output_duration"];
type BillingStrategy = (typeof BILLING_STRATEGIES)[number];
type ImageBillingStrategy = "output_count" | "person_output_count";
type PresetPriceBehavior = "override_model" | "use_model";
type ConfirmationReason = "output_count_threshold" | "image_credits_threshold" | "video_credits_threshold";
type UnitPricingPlan = {
    billing_strategy: ImageBillingStrategy | "input_count";
    unit_credits: number;
};
type PricingPlan = UnitPricingPlan | {
    billing_strategy: "output_duration" | "input_plus_output_duration";
    credits_per_second: number;
    rounding: "ceil";
};
interface PresetPricingCandidate {
    billing_strategy: ImageBillingStrategy;
    unit_credits: number | null;
    [key: string]: unknown;
}
interface EstimateMeasurements {
    input_count?: number | undefined;
    person_count?: number | undefined;
    output_count?: number | undefined;
    output_count_per_person?: number | undefined;
    output_duration_seconds?: number | undefined;
    input_video_duration_seconds?: number | undefined;
}
interface ConfirmationThresholds {
    output_count: number;
    image_credits: number;
    video_credits: number;
}
interface EstimateGenerationCreditsInput {
    estimation_contract_version: 1;
    pricing: PricingPlan;
    preset?: PresetPricingCandidate | null | undefined;
    preset_price_behavior?: PresetPriceBehavior | undefined;
    measurements: EstimateMeasurements;
    confirmation_thresholds: ConfirmationThresholds;
}
interface EstimateGenerationCreditsResult {
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
declare function estimateGenerationCredits(input: EstimateGenerationCreditsInput): EstimateGenerationCreditsResult;

declare function assertSupportedRuntime(): void;
declare function assertRuntimeDependencies(): Promise<void>;
declare function resolveDataDirectory(): string;
declare function resolveOpenClawAttachmentRegistryDirectory(): string;

interface UploadTargetPolicy {
    assertUrl(rawUrl: string): URL;
    lookup: LookupFunction;
}
declare function createUploadTargetPolicy(patterns?: string[]): UploadTargetPolicy;
declare function configuredHostPatterns(): string[];
declare function isPublicAddress(value: string): boolean;

type MediaKind = "image" | "video" | "audio";
type SupportedMediaFormat = "jpeg" | "png" | "webp" | "mp4" | "mov" | "wav" | "mp3";
interface MediaMetadata {
    width?: number;
    height?: number;
    duration_seconds?: number;
    frame_rate?: number;
    audio_channels?: number;
    sample_rate?: number;
}
interface AttachmentFileIdentity {
    device: string;
    inode: string;
    size: number;
    modified_at_ns: string;
    changed_at_ns: string;
}
interface InspectedAttachment {
    record_type: "inspected";
    handle_digest: string;
    scope_digest?: string;
    source_path: string;
    filename: string;
    kind: MediaKind;
    format: SupportedMediaFormat;
    content_type: string;
    size: number;
    source_checksum: string;
    file_identity: AttachmentFileIdentity;
    metadata: MediaMetadata;
    expires_at: string;
}
interface StagedAttachment {
    record_type: "staged";
    handle_digest: string;
    scope_digest?: string;
    staged_file_id: string;
    content_type: string;
    size: number;
    checksum: string;
    expires_at: string;
}
interface InspectedAttachmentResult {
    attachment_handle: string;
    kind: MediaKind;
    content_type: string;
    byte_size: number;
    metadata: MediaMetadata;
    expires_at: string;
}
interface CreateDirectUploadArguments {
    filename: string;
    kind: MediaKind;
    content_type: string;
    byte_size: number;
    checksum: string;
    upload_checksum: string;
    metadata: MediaMetadata;
}
interface PreparedAttachmentResult {
    staged_handle: string;
    create_direct_upload_args: CreateDirectUploadArguments;
    expires_at: string;
}
interface DirectUpload {
    asset_id: string;
    upload_url: string;
    headers: Record<string, string>;
    expires_at: string;
}

interface AttachmentPipelinePort {
    inspect(sourceReference: string, scope?: string): Promise<InspectedAttachmentResult>;
    prepare(attachmentHandle: string, scope?: string): Promise<PreparedAttachmentResult>;
    upload(stagedHandle: string, directUpload: DirectUpload, scope?: string): Promise<{
        asset_id: string;
    }>;
    cleanupExpired(): Promise<void>;
}
declare class AttachmentPipeline implements AttachmentPipelinePort {
    private readonly store;
    private readonly inspectAttachment;
    private readonly prepareAttachment;
    private readonly uploadAttachment;
    private constructor();
    static create(stateDirectory: string): Promise<AttachmentPipeline>;
    inspect(sourceReference: string, scope?: string): Promise<InspectedAttachmentResult>;
    prepare(attachmentHandle: string, scope?: string): Promise<PreparedAttachmentResult>;
    upload(stagedHandle: string, directUpload: DirectUpload, scope?: string): Promise<{
        asset_id: string;
    }>;
    cleanupExpired(): Promise<void>;
}

declare class HandleStore {
    private readonly root;
    private readonly inspectedRecordsDirectory;
    private readonly stagedRecordsDirectory;
    private readonly stagedFilesDirectory;
    constructor(root: string);
    initialize(): Promise<void>;
    createInspection(record: Omit<InspectedAttachment, "handle_digest">): Promise<string>;
    createStage(buffer: Buffer, record: Omit<StagedAttachment, "handle_digest" | "staged_file_id">): Promise<string>;
    withInspection<T>(handle: string, action: (record: InspectedAttachment) => Promise<T>, scopeDigest?: string): Promise<T>;
    withStage<T>(handle: string, action: (record: StagedAttachment, filePath: string) => Promise<T>, scopeDigest?: string): Promise<T>;
    cleanupExpired(now?: Date): Promise<void>;
    private inspectedAccess;
    private stagedAccess;
    private writeRecord;
    private withRecord;
    private assertScope;
    private claimRecord;
    private assertNotExpired;
    private restoreClaim;
    private cleanupLayout;
    private cleanupRecordDirectory;
}

export { type AttachmentFileIdentity, AttachmentPipeline, type AttachmentPipelinePort, BILLING_STRATEGIES, type BillingStrategy, type ConfirmationReason, type ConfirmationThresholds, type CreateDirectUploadArguments, DEFAULT_UPLOAD_HOST_PATTERNS, type DirectUpload, type EstimateGenerationCreditsInput, type EstimateGenerationCreditsResult, type EstimateMeasurements, HANDLE_CLEANUP_INTERVAL_MS, HANDLE_TTL_MS, HandleStore, type ImageBillingStrategy, type InspectedAttachment, type InspectedAttachmentResult, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, MAX_INPUT_BYTES, MAX_MEDIA_DURATION_SECONDS, MAX_VIDEO_BYTES, MIN_MEDIA_DURATION_SECONDS, type MediaKind, type MediaMetadata, PluginError, type PreparedAttachmentResult, type PresetPriceBehavior, type PresetPricingCandidate, type PricingPlan, RUNTIME_VERSION, type StagedAttachment, type SupportedMediaFormat, UPLOAD_TIMEOUT_MS, type UnitPricingPlan, type UploadTargetPolicy, assertRuntimeDependencies, assertSupportedRuntime, configuredHostPatterns, createDirectUploadArgumentsSchema, createUploadTargetPolicy, directUploadSchema, estimateGenerationCredits, estimateOutputSchema, inspectedOutputSchema, isPublicAddress, lookbookEstimateInputSchema, mediaMetadataSchema, poseEstimateInputSchema, preparedOutputSchema, resolveDataDirectory, resolveOpenClawAttachmentRegistryDirectory, toPluginError, upscaleEstimateInputSchema, videoEstimateInputSchema };
