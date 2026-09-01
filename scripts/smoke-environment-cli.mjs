import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-env-cli-smoke-"));
const codexBin = path.join(root, "codex-fixture.mjs");
const pluginRoot = path.join(root, "plugin");
const openClawBin = path.join(root, "openclaw-fixture.mjs");
const openClawState = path.join(root, "openclaw-mcp.json");

try {
  await writeFile(codexBin, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'plugin' && args[1] === 'list') {",
    `  process.stdout.write(JSON.stringify({ installed: [{ name: 'quick-image', enabled: true, source: { path: '${pluginRoot}' } }] }));`,
    "} else if (args[0] === 'mcp' && args[1] === 'get') {",
    "  process.stdout.write(JSON.stringify({ transport: {",
    "    url: 'https://staging-api.example.com/mcp',",
    "    http_headers: {",
    "      'X-Quick-Image-Plugin-Version': '0.1.0',",
    "      'X-Quick-Image-Frontend-URL': 'https://staging.example.com'",
    "    }",
    "  } }));",
    "} else {",
    "  process.stdout.write('[]');",
    "}",
    ""
  ].join("\n"), { mode: 0o700 });
  await chmod(codexBin, 0o700);
  await mkdir(pluginRoot, { recursive: true });
  const manifest = JSON.stringify({
    mcpServers: {
      "quick-image": {
        type: "http",
        url: "https://quickimage.ai/mcp",
        headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0"
        }
      }
    }
  });
  await writeFile(path.join(pluginRoot, ".mcp.json"), manifest);
  await writeFile(path.join(pluginRoot, "mcp.json"), manifest);

  const result = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "quick-image.js"),
    "env",
    "set",
    "--host",
    "codex",
    "--server-url",
    "https://staging-api.example.com/mcp",
    "--frontend-url",
    "https://staging.example.com",
    "--codex-bin",
    codexBin,
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    throw new Error(`environment CLI failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const config = await readFile(path.join(pluginRoot, ".mcp.json"), "utf8");
  const parsedConfig = JSON.parse(config);
  if (parsedConfig.mcpServers?.["quick-image"]?.url !== "https://staging-api.example.com/mcp") {
    throw new Error("environment CLI did not update the Codex Plugin manifest");
  }
  if (parsedConfig.mcpServers?.["quick-image"]?.headers?.["X-Quick-Image-Plugin-Version"] !== "0.1.0") {
    throw new Error("environment CLI unexpectedly changed the Codex Plugin version");
  }

  await writeFile(openClawBin, [
    "#!/usr/bin/env node",
    "const fs = await import('node:fs');",
    "const args = process.argv.slice(2);",
    "const state = process.env.QUICK_IMAGE_OPENCLAW_FIXTURE;",
    "if (!state) process.exit(2);",
    "if (args[0] === 'mcp' && args[1] === 'set') {",
    "  fs.writeFileSync(state, args[3]);",
    "} else if (args[0] === 'config' && args[1] === 'get') {",
    "  if (!fs.existsSync(state)) process.exit(1);",
    "  process.stdout.write(fs.readFileSync(state, 'utf8'));",
    "}",
    ""
  ].join("\n"), { mode: 0o700 });
  await chmod(openClawBin, 0o700);
  await writeFile(openClawState, JSON.stringify({
    transport: "streamable-http",
    url: "https://quickimage.ai/mcp",
    auth: "oauth",
    oauth: { scope: "presets:read assets:write tasks:read tasks:write" },
    headers: {
      "X-Quick-Image-Plugin-Version": "0.1.0",
      "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
    },
    custom_timeout_ms: 5000
  }));

  const openClawResult = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "quick-image.js"),
    "env",
    "set",
    "--host",
    "openclaw",
    "--server-url",
    "https://staging-api.example.com/mcp",
    "--frontend-url",
    "https://staging.example.com",
    "--openclaw-bin",
    openClawBin
  ], {
    encoding: "utf8",
    env: { ...process.env, QUICK_IMAGE_OPENCLAW_FIXTURE: openClawState }
  });
  if (openClawResult.status !== 0) {
    throw new Error(`OpenClaw environment CLI failed: ${(openClawResult.stderr || openClawResult.stdout).trim()}`);
  }
  const openClawConfig = JSON.parse(await readFile(openClawState, "utf8"));
  if (openClawConfig.url !== "https://staging-api.example.com/mcp" ||
      openClawConfig.headers?.["X-Quick-Image-Frontend-URL"] !== "https://staging.example.com") {
    throw new Error("environment CLI did not update the OpenClaw MCP configuration");
  }

  const doctorResult = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "doctor.js"),
    "--host",
    "codex"
  ], {
    encoding: "utf8",
    env: { ...process.env, QUICK_IMAGE_DATA_DIR: root }
  });
  if (doctorResult.status !== 0 || JSON.parse(doctorResult.stdout).ok !== true) {
    throw new Error(`Doctor CLI failed: ${(doctorResult.stderr || doctorResult.stdout).trim()}`);
  }
  process.stdout.write("Environment and Doctor CLI smoke tests passed for Codex and OpenClaw.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
