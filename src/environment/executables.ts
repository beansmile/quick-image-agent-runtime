import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCodexExecutable(explicitPath?: string): string {
  const configured = explicitPath?.trim() || process.env.CODEX_CLI_PATH?.trim();
  if (configured) return requireExecutable(configured, "指定的 Codex CLI");

  const pathMatch = findOnPath("codex");
  if (pathMatch) return pathMatch;
  if (process.platform === "darwin") {
    for (const applicationName of ["ChatGPT.app", "Codex.app"]) {
      for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
        const candidate = path.join(base, applicationName, "Contents", "Resources", "codex");
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  throw new Error("找不到 Codex CLI；请将 codex 加入 PATH，或使用 --codex-bin 指定路径");
}

export function resolveOpenClawExecutable(explicitPath?: string): string {
  const configured = explicitPath?.trim() || process.env.OPENCLAW_CLI_PATH?.trim();
  if (configured) return requireExecutable(configured, "指定的 OpenClaw CLI");
  return findOnPath("openclaw") ?? "openclaw";
}

function findOnPath(command: string): string | undefined {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function requireExecutable(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  if (!isExecutable(resolved)) throw new Error(`${label}不存在或不可执行：${resolved}`);
  return resolved;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
