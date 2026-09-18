import packageJson from "../package.json" with { type: "json" };

export const RUNTIME_VERSION = packageJson.version;
export const HANDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const HANDLE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_IMAGE_BYTES = Math.floor(6.5 * 1024 * 1024);
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_INPUT_BYTES = MAX_VIDEO_BYTES;
export const MAX_IMAGE_EDGE = 3072;
export const MIN_MEDIA_DURATION_SECONDS = 2;
export const MAX_MEDIA_DURATION_SECONDS = 15;
export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_UPLOAD_HOST_PATTERNS = ["quickimage.ai", "*.quickimage.ai", "*.aliyuncs.com"];
// 以下为客户端 Runtime 自设的预览下载防御值：服务端契约未声明预览大小，
// 渠道限制发生在发送阶段且各不相同，这里只防止异常大文件占满磁盘、悬挂请求占住工具调用。
export const PREVIEW_DOWNLOAD_TIMEOUT_MS = 60 * 1000;
export const MAX_PREVIEW_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const PREVIEW_CACHE_CLEANUP_THRESHOLD_BYTES = 200 * 1024 * 1024;
