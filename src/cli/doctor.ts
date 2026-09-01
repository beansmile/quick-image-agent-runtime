import os from "node:os";
import path from "node:path";
import {
  assertRuntimeDependencies,
  assertSupportedRuntime,
  resolveDataDirectory
} from "../runtime.js";
import { configuredHostPatterns, createUploadTargetPolicy } from "../security/upload-target.js";
import { HandleStore } from "../store/handle-store.js";
import { checkOpenClawToolPolicy, OpenClawPolicyError } from "./openclaw-policy.js";

type Host = "codex" | "openclaw";

interface CheckResult {
  check: string;
  status: "pass" | "fail";
  message: string;
}

async function main(): Promise<void> {
  const host = parseHost(process.argv.slice(2));
  const results: CheckResult[] = [];
  await runCheck(results, "runtime", async () => assertSupportedRuntime(), "Node.js 和操作系统受支持");
  await runCheck(results, "dependencies", checkDependencies, "媒体处理依赖可加载");
  await runCheck(results, "private-state", checkStateDirectory, "私有状态目录可用");
  await runCheck(results, "upload-policy", checkUploadPolicy, "上传域名策略有效");
  if (host === "openclaw") {
    const stateDirectory = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDirectory, "openclaw.json");
    await runCheck(
      results,
      "tool-policy",
      () => checkOpenClawToolPolicy(configPath),
      "Quick Image 原生工具已获当前 OpenClaw 工具策略授权"
    );
  }

  const ok = results.every((result) => result.status === "pass");
  process.stdout.write(`${JSON.stringify({ ok, host, checks: results }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

async function checkDependencies(): Promise<void> {
  await assertRuntimeDependencies();
}

async function checkStateDirectory(): Promise<void> {
  const store = new HandleStore(resolveDataDirectory());
  await store.initialize();
}

function checkUploadPolicy(): void {
  createUploadTargetPolicy(configuredHostPatterns());
}

function parseHost(argv: string[]): Host {
  const index = argv.indexOf("--host");
  const value = index === -1 ? undefined : argv[index + 1];
  if (value !== "codex" && value !== "openclaw") {
    throw new Error("--host must be codex or openclaw");
  }
  return value;
}

async function runCheck(
  results: CheckResult[],
  check: string,
  action: () => void | Promise<void>,
  successMessage: string
): Promise<void> {
  try {
    await action();
    results.push({ check, status: "pass", message: successMessage });
  } catch (error) {
    const message = error instanceof OpenClawPolicyError
      ? error.message
      : `${check} 检查未通过；请按安装文档修复后再启用 Quick Image。`;
    results.push({ check, status: "fail", message });
  }
}

main().catch(() => {
  process.stderr.write('{"ok":false,"code":"DOCTOR_FAILED"}\n');
  process.exitCode = 1;
});
