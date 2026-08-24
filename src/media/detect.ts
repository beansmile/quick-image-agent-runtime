import { PluginError } from "../errors.js";
import type { MediaKind, SupportedMediaFormat } from "../types.js";

interface DetectedMedia {
  kind: MediaKind;
  format: SupportedMediaFormat;
  contentType: string;
  extension: string;
}

const FORMATS: Record<SupportedMediaFormat, DetectedMedia> = {
  jpeg: { kind: "image", format: "jpeg", contentType: "image/jpeg", extension: ".jpg" },
  png: { kind: "image", format: "png", contentType: "image/png", extension: ".png" },
  webp: { kind: "image", format: "webp", contentType: "image/webp", extension: ".webp" },
  mp4: { kind: "video", format: "mp4", contentType: "video/mp4", extension: ".mp4" },
  mov: { kind: "video", format: "mov", contentType: "video/quicktime", extension: ".mov" },
  wav: { kind: "audio", format: "wav", contentType: "audio/wav", extension: ".wav" },
  mp3: { kind: "audio", format: "mp3", contentType: "audio/mpeg", extension: ".mp3" }
};

export function detectMedia(buffer: Buffer): DetectedMedia {
  if (buffer.length < 12) throw unsupported();

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return FORMATS.jpeg;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
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

function isMp3FrameHeader(first: number | undefined, second: number | undefined): boolean {
  return first === 0xff && second !== undefined && (second & 0xe0) === 0xe0 && (second & 0x06) !== 0;
}

function unsupported(): PluginError {
  return new PluginError("UNSUPPORTED_MEDIA_FORMAT", "只支持静态 JPEG、PNG、WebP、MP4、MOV、WAV 和 MP3。", {
    field: "format"
  });
}
