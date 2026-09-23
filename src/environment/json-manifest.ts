import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// 插件 MCP 清单是宿主与 git 共管的 JSON 文件：解析时剥离 UTF-8 BOM，序列化时
// 按原文还原 BOM、缩进、行尾与结尾换行，尽量少改动无关字节；写入走临时文件
// 原子替换，Windows 上宿主短暂占用目标文件时退化为整块覆盖。
export function parseJsonManifestText(text: string, source: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(stripByteOrderMark(text));
    if (isObject(value)) return value;
  } catch {
    // 统一转译为带文件路径的错误，便于定位损坏的安装。
  }
  throw new Error(`MCP 清单不是有效 JSON：${source}`);
}

export function serializeJsonManifestText(value: Record<string, unknown>, originalText: string): string {
  const byteOrderMark = originalText.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const lineEnding = originalText.includes("\r\n") ? "\r\n" : "\n";
  const serialized = serializeWithOriginalWhitespace(value, originalText);
  const body = lineEnding === "\r\n" ? serialized.replace(/\n/g, "\r\n") : serialized;
  const trailingNewline = originalText.endsWith("\n") ? lineEnding : "";
  return `${byteOrderMark}${body}${trailingNewline}`;
}

export function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function writeJsonManifestAtomic(filePath: string, content: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.quick-image-${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode });
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      // Windows 上宿主进程短暂占用目标文件时 rename 可能失败；退化为
      // copyFile+unlink，内容仍按整块覆盖，不会写出半个清单。
      await copyFile(temporaryPath, filePath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

// JSON.stringify 的产物不含裸换行，逐个替换 \n 为 \r\n 不会破坏字符串内容。
function serializeWithOriginalWhitespace(value: Record<string, unknown>, originalText: string): string {
  const text = stripByteOrderMark(originalText);
  const firstLineBreak = text.indexOf("\n");
  // 原文没有换行，或唯一换行是结尾换行，说明是单行压缩格式，保持压缩。
  if (firstLineBreak === -1 || firstLineBreak === text.length - 1) return JSON.stringify(value);
  const indent = /^[ \t]+/.exec(text.slice(firstLineBreak + 1))?.[0];
  if (!indent) return JSON.stringify(value, null, 2);
  return JSON.stringify(value, null, indent.slice(0, 10));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
