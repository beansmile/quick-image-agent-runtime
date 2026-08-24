import sharp from "sharp";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from "../constants.js";
import { PluginError } from "../errors.js";
import type { MediaMetadata, SupportedMediaFormat } from "../types.js";

interface ProcessedImage {
  buffer: Buffer;
  metadata: MediaMetadata;
}

const MIN_QUALITY = 50;
const MAX_INPUT_PIXELS = 100_000_000;

export async function inspectImage(input: Buffer, expectedFormat: SupportedMediaFormat): Promise<MediaMetadata> {
  try {
    const metadata = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) throw invalidImage();
    if ((metadata.pages ?? 1) > 1) {
      throw new PluginError("ANIMATED_IMAGE_UNSUPPORTED", "只支持静态图片。", { field: "format" });
    }
    if (normalizeSharpFormat(metadata.format) !== expectedFormat) throw invalidImage();
    return { width: metadata.autoOrient.width, height: metadata.autoOrient.height };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalidImage();
  }
}

export async function processImage(input: Buffer, expectedFormat: SupportedMediaFormat): Promise<ProcessedImage> {
  try {
    const source = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS });
    const sourceMetadata = await source.metadata();
    if (!sourceMetadata.width || !sourceMetadata.height || !sourceMetadata.format) throw invalidImage();
    if ((sourceMetadata.pages ?? 1) > 1) {
      throw new PluginError("ANIMATED_IMAGE_UNSUPPORTED", "只支持静态图片。", { field: "format" });
    }
    if (normalizeSharpFormat(sourceMetadata.format) !== expectedFormat) throw invalidImage();

    let width = sourceMetadata.autoOrient.width;
    let height = sourceMetadata.autoOrient.height;
    const edgeScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    width = Math.max(1, Math.floor(width * edgeScale));
    height = Math.max(1, Math.floor(height * edgeScale));

    let output: Buffer | undefined;
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
      throw new PluginError("IMAGE_COMPRESSION_FAILED", "图片压缩后仍超过 6.5 MiB。", {
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

async function encode(
  input: Buffer,
  format: SupportedMediaFormat,
  width: number,
  height: number,
  quality: number,
  scale: number
): Promise<Buffer> {
  const pipeline = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .resize({
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

function normalizeSharpFormat(format: string): SupportedMediaFormat | undefined {
  if (format === "jpg" || format === "jpeg") return "jpeg";
  if (format === "png" || format === "webp") return format;
  return undefined;
}

function invalidImage(): PluginError {
  return new PluginError("INVALID_IMAGE", "图片文件损坏或无法安全解码。", { field: "attachment" });
}
