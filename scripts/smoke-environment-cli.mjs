import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-env-cli-smoke-"));
const codexBin = path.join(root, "codex-fixture.mjs");
const codexHome = path.join(root, ".codex");
const codexConfigPath = path.join(codexHome, "config.toml");
const openClawBin = path.join(root, "openclaw-fixture.mjs");
const openClawState = path.join(root, "openclaw-mcp.json");
const originalCodexConfig = 'model = "gpt-test"\n';

try {
  await mkdir(codexHome, { recursive: true });
  await writeFile(codexConfigPath, originalCodexConfig);
  await writeFile(codexBin, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'mcp' && args[1] === 'get') {",
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
  ], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });

  if (result.status !== 0) {
    throw new Error(`environment CLI failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const updatedCodexConfig = await readFile(codexConfigPath, "utf8");
  if (!updatedCodexConfig.includes("BEGIN quick-image managed MCP environment") ||
      !updatedCodexConfig.includes('url = "https://staging-api.example.com/mcp"') ||
      !updatedCodexConfig.includes('model = "gpt-test"')) {
    throw new Error("environment CLI did not append the managed Quick Image block to Codex config.toml");
  }
  if (await readFile(`${codexConfigPath}.quick-image-backup`, "utf8").then((content) => content !== originalCodexConfig).catch(() => true)) {
    throw new Error("environment CLI did not back up Codex config.toml before writing");
  }

  const resetBin = path.join(root, "codex-reset-fixture.mjs");
  await writeFile(resetBin, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'mcp' && args[1] === 'get') {",
    "  process.stdout.write(JSON.stringify({ transport: {",
    "    url: 'https://quickimage.ai/mcp',",
    "    http_headers: {",
    "      'X-Quick-Image-Plugin-Version': '0.1.0',",
    "      'X-Quick-Image-Frontend-URL': 'https://quickimage.ai'",
    "    }",
    "  } }));",
    "} else {",
    "  process.stdout.write('[]');",
    "}",
    ""
  ].join("\n"), { mode: 0o700 });
  await chmod(resetBin, 0o700);
  const resetResult = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "quick-image.js"),
    "env",
    "reset",
    "--host",
    "codex",
    "--codex-bin",
    resetBin
  ], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });
  if (resetResult.status !== 0) {
    throw new Error(`environment reset CLI failed: ${(resetResult.stderr || resetResult.stdout).trim()}`);
  }
  if (await readFile(codexConfigPath, "utf8").then((content) => content !== originalCodexConfig)) {
    throw new Error("environment reset CLI did not restore the original Codex config.toml");
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

  const workBuddyHome = path.join(root, ".workbuddy");
  const workBuddyRoot = path.join(workBuddyHome, "plugins", "cache", "quick-image", "quick-image", "0.1.8");
  const workBuddyMcpPath = path.join(workBuddyRoot, ".mcp.json");
  const originalWorkBuddyMcp = `${JSON.stringify({
    mcpServers: {
      "quick-image": {
        type: "http",
        url: "https://quickimage.ai/mcp",
        headers: {
          "X-Quick-Image-Plugin-Version": "0.1.8",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        },
        http_headers: {
          "X-Quick-Image-Plugin-Version": "0.1.8",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        }
      },
      "quick-image-local": {
        type: "stdio",
        command: "npx",
        args: ["--yes", "--package", "quick-image-agent-runtime@0.2.8", "quick-image-local-mcp"]
      }
    }
  }, null, 2)}\n`;
  await mkdir(path.join(workBuddyRoot, ".workbuddy-plugin"), { recursive: true });
  await writeFile(path.join(workBuddyRoot, ".workbuddy-plugin", "plugin.json"), JSON.stringify({
    name: "quick-image",
    version: "0.1.8",
    skills: "./skills/",
    mcpServers: "./.mcp.json"
  }));
  await writeFile(workBuddyMcpPath, originalWorkBuddyMcp);
  await writeFile(path.join(workBuddyHome, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "quick-image@quick-image": [{
        scope: "user",
        installPath: workBuddyRoot,
        version: "0.1.8",
        installedAt: "2026-09-21T15:19:54.090Z",
        lastUpdated: "2026-09-21T15:19:54.090Z"
      }]
    }
  }));

  const workBuddySet = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "quick-image.js"),
    "env",
    "set",
    "--host",
    "workbuddy",
    "--server-url",
    "https://staging-api.example.com/mcp",
    "--frontend-url",
    "https://staging.example.com"
  ], { encoding: "utf8", env: { ...process.env, WORKBUDDY_HOME: workBuddyHome } });
  if (workBuddySet.status !== 0) {
    throw new Error(`WorkBuddy environment CLI failed: ${(workBuddySet.stderr || workBuddySet.stdout).trim()}`);
  }
  const workBuddyUpdated = JSON.parse(await readFile(workBuddyMcpPath, "utf8"));
  if (workBuddyUpdated.mcpServers["quick-image"].url !== "https://staging-api.example.com/mcp" ||
      workBuddyUpdated.mcpServers["quick-image"].headers["X-Quick-Image-Frontend-URL"] !== "https://staging.example.com" ||
      JSON.stringify(workBuddyUpdated.mcpServers["quick-image-local"]) !==
        JSON.stringify(JSON.parse(originalWorkBuddyMcp).mcpServers["quick-image-local"])) {
    throw new Error("environment CLI did not update only the quick-image entry in the WorkBuddy MCP manifest");
  }
  if (await readFile(`${workBuddyMcpPath}.quick-image-backup`, "utf8").then((content) => content !== originalWorkBuddyMcp).catch(() => true)) {
    throw new Error("environment CLI did not back up the WorkBuddy MCP manifest before writing");
  }

  const workBuddyReset = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "quick-image.js"),
    "env",
    "reset",
    "--host",
    "workbuddy"
  ], { encoding: "utf8", env: { ...process.env, WORKBUDDY_HOME: workBuddyHome } });
  if (workBuddyReset.status !== 0) {
    throw new Error(`WorkBuddy reset CLI failed: ${(workBuddyReset.stderr || workBuddyReset.stdout).trim()}`);
  }
  const workBuddyResetConfig = JSON.parse(await readFile(workBuddyMcpPath, "utf8"));
  if (workBuddyResetConfig.mcpServers["quick-image"].url !== "https://quickimage.ai/mcp" ||
      workBuddyResetConfig.mcpServers["quick-image"].headers["X-Quick-Image-Frontend-URL"] !== "https://quickimage.ai") {
    throw new Error("WorkBuddy environment reset CLI did not restore the production MCP configuration");
  }

  process.stdout.write("Environment CLI smoke tests passed for Codex, OpenClaw, and WorkBuddy.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
