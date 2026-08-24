import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HANDLE_CLEANUP_INTERVAL_MS, RUNTIME_VERSION } from "./constants.js";
import {
  directUploadSchema,
  estimateOutputSchema,
  inspectedOutputSchema,
  lookbookEstimateInputSchema,
  poseEstimateInputSchema,
  preparedOutputSchema,
  upscaleEstimateInputSchema,
  videoEstimateInputSchema
} from "./contracts/local-tool-schemas.js";
import { toPluginError } from "./errors.js";
import { estimateGenerationCredits } from "./pricing/estimate-generation-credits.js";
import { assertSupportedRuntime, resolveDataDirectory } from "./runtime.js";
import { AttachmentPipeline } from "./services/attachment-pipeline.js";

async function main(): Promise<void> {
  assertSupportedRuntime();
  const attachments = await AttachmentPipeline.create(resolveDataDirectory());

  const server = new McpServer({ name: "quick-image-local", version: RUNTIME_VERSION });
  server.registerTool(
    "inspect_attachment",
    {
      title: "检查 Quick Image 附件",
      description: "读取 Codex 当前对话明确提供并经宿主批准的绝对路径，校验媒体并返回不包含附件字节的轻量检查句柄。此步骤不压缩、不暂存、不上传附件。",
      inputSchema: z.object({
        path: z.string().min(1).describe("Codex 当前对话附件明确提供的绝对本地路径；调用前必须由宿主向用户显示工具审批")
      }),
      outputSchema: inspectedOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ path }) => executeTool(() => attachments.inspect(path))
  );

  server.registerTool(
    "prepare_attachment",
    {
      title: "准备 Quick Image 附件",
      description: "在用户确认报价后重新读取已检查的原始附件，校验文件未变化并预处理媒体，返回暂存句柄及可整体转交给 create_direct_upload 的参数对象。成功后会消费检查句柄。",
      inputSchema: z.object({
        attachment_handle: z.string().min(1).describe("inspect_attachment 返回的一次性检查句柄")
      }),
      outputSchema: preparedOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ attachment_handle }) => executeTool(() => attachments.prepare(attachment_handle))
  );

  server.registerTool(
    "estimate_lookbook_credits",
    {
      title: "预估 Quick Image 搭配积分",
      description: "使用搭配模型价格、可选模板价格和输出数量确定性计算预计积分与额外确认原因。",
      inputSchema: lookbookEstimateInputSchema,
      outputSchema: estimateOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ estimation_contract_version, pricing, preset, preset_price_behavior, output_count, confirmation_thresholds }) =>
      executeTool(() => estimateGenerationCredits({
        estimation_contract_version,
        pricing,
        preset,
        preset_price_behavior,
        measurements: { output_count },
        confirmation_thresholds
      }))
  );

  server.registerTool(
    "estimate_pose_credits",
    {
      title: "预估 Quick Image 换姿积分",
      description: "使用换姿模型价格、可选模板价格、人物数和单人输出数确定性计算预计积分与额外确认原因。",
      inputSchema: poseEstimateInputSchema,
      outputSchema: estimateOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ estimation_contract_version, pricing, preset, preset_price_behavior, person_count, output_count_per_person, confirmation_thresholds }) =>
      executeTool(() => estimateGenerationCredits({
        estimation_contract_version,
        pricing,
        preset,
        preset_price_behavior,
        measurements: { person_count, output_count_per_person },
        confirmation_thresholds
      }))
  );

  server.registerTool(
    "estimate_upscale_credits",
    {
      title: "预估 Quick Image 高清积分",
      description: "使用高清价格和输入图片数量确定性计算预计积分与额外确认原因。",
      inputSchema: upscaleEstimateInputSchema,
      outputSchema: estimateOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ estimation_contract_version, pricing, input_count, confirmation_thresholds }) =>
      executeTool(() => estimateGenerationCredits({
        estimation_contract_version,
        pricing,
        measurements: { input_count },
        confirmation_thresholds
      }))
  );

  server.registerTool(
    "estimate_video_credits",
    {
      title: "预估 Quick Image 视频积分",
      description: "使用视频价格、输出时长和可选输入视频时长确定性计算预计积分与额外确认原因。",
      inputSchema: videoEstimateInputSchema,
      outputSchema: estimateOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ estimation_contract_version, pricing, output_duration_seconds, input_video_duration_seconds, confirmation_thresholds }) =>
      executeTool(() => estimateGenerationCredits({
        estimation_contract_version,
        pricing,
        measurements: {
          output_duration_seconds,
          ...(input_video_duration_seconds === null ? {} : { input_video_duration_seconds })
        },
        confirmation_thresholds
      }))
  );

  server.registerTool(
    "upload_staged_attachment",
    {
      title: "上传 Quick Image 暂存附件",
      description: "使用远程 Quick Image MCP 签发的完整直传信息上传完全相同的暂存文件，成功后消费句柄。",
      inputSchema: z.object({
        staged_handle: z.string().describe("prepare_attachment 返回的一次性暂存句柄"),
        direct_upload: directUploadSchema.describe("create_direct_upload 返回的完整直传信息，不得手工修改")
      }),
      outputSchema: z.object({ asset_id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ staged_handle, direct_upload }) =>
      executeTool(() => attachments.upload(staged_handle, direct_upload))
  );

  const cleanupTimer = setInterval(() => {
    void attachments.cleanupExpired().catch(() => {
      process.stderr.write(`${JSON.stringify({ code: "ATTACHMENT_CLEANUP_FAILED" })}\n`);
    });
  }, HANDLE_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanupTimer);
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toolResult<T extends object>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}

async function executeTool<T extends object>(action: () => Promise<T> | T) {
  try {
    return toolResult(await action());
  } catch (error) {
    const publicError = toPluginError(error).toPublicObject();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(publicError) }],
      isError: true
    };
  }
}

main().catch((error: unknown) => {
  const publicError = toPluginError(error);
  process.stderr.write(`${JSON.stringify(publicError.toPublicObject())}\n`);
  process.exitCode = 1;
});
