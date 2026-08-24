import { createRequire } from "node:module";
import mediaInfoFactory, {
  isTrackType,
  type AudioTrack,
  type GeneralTrack,
  type VideoTrack
} from "mediainfo.js";
import { MAX_MEDIA_DURATION_SECONDS, MIN_MEDIA_DURATION_SECONDS } from "../constants.js";
import { PluginError } from "../errors.js";
import type { MediaMetadata, SupportedMediaFormat } from "../types.js";

const require = createRequire(import.meta.url);

export async function inspectAudioVideo(
  buffer: Buffer,
  expectedFormat: SupportedMediaFormat
): Promise<MediaMetadata> {
  const wasmPath = require.resolve("mediainfo.js/MediaInfoModule.wasm");
  const mediaInfo = await mediaInfoFactory({ format: "object", locateFile: () => wasmPath });
  try {
    const result = await mediaInfo.analyzeData(buffer.length, (size, offset) => buffer.subarray(offset, offset + size));
    const tracks = result.media?.track ?? [];
    const general = tracks.find((track): track is GeneralTrack => isTrackType(track, "General"));
    const video = tracks.find((track): track is VideoTrack => isTrackType(track, "Video"));
    const audio = tracks.find((track): track is AudioTrack => isTrackType(track, "Audio"));

    if (expectedFormat === "mp4" || expectedFormat === "mov") {
      if (!video || !isExpectedContainer(general?.Format, expectedFormat)) throw invalidMedia();
    } else if (
      (expectedFormat !== "wav" && expectedFormat !== "mp3") ||
      !audio ||
      video ||
      !isExpectedAudio(general?.Format, audio.Format, expectedFormat)
    ) {
      throw invalidMedia();
    }

    const duration = finiteNumber(general?.Duration ?? video?.Duration ?? audio?.Duration);
    if (duration === undefined) throw invalidMedia();
    if (duration < MIN_MEDIA_DURATION_SECONDS || duration > MAX_MEDIA_DURATION_SECONDS) {
      throw new PluginError("MEDIA_DURATION_OUT_OF_RANGE", "音视频时长必须在 2 到 15 秒之间。", {
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

function isExpectedContainer(format: string | undefined, expected: "mp4" | "mov"): boolean {
  const normalized = format?.toLowerCase() ?? "";
  if (expected === "mov") return normalized.includes("quicktime") || normalized.includes("mpeg-4");
  return normalized.includes("mpeg-4") || normalized === "mp4";
}

function isExpectedAudio(
  generalFormat: string | undefined,
  audioFormat: string | undefined,
  expected: "wav" | "mp3"
): boolean {
  const combined = `${generalFormat ?? ""} ${audioFormat ?? ""}`.toLowerCase();
  return expected === "wav" ? combined.includes("wave") || combined.includes("pcm") : combined.includes("mpeg audio");
}

function compactMetadata(entries: Array<[keyof MediaMetadata, number | undefined]>): MediaMetadata {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as MediaMetadata;
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteInteger(value: number | undefined): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.round(number);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundOptional(value: number | undefined, digits: number): number | undefined {
  return value === undefined ? undefined : round(value, digits);
}

function invalidMedia(): PluginError {
  return new PluginError("INVALID_MEDIA", "音视频文件损坏、格式不匹配或无法读取元数据。", {
    field: "attachment"
  });
}
