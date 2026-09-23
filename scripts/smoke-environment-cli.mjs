import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = await mkdtemp(path.join(os.tmpdir(), "quick-image-env-cli-smoke-"));
const codexHome = path.join(root, ".codex");
const codexConfigPath = path.join(codexHome, "config.toml");
const openClawBin = path.join(root, "openclaw-fixture.mjs");
const openClawState = path.join(root, "openclaw-mcp.json");
const originalCodexConfig = 'model = "gpt-test"\n';

try {
  await mkdir(codexHome, { recursive: true });
  await writeFile(codexConfigPath, originalCodexConfig);

  const marketplaceRoot = path.join(codexHome, ".tmp", "marketplaces", "quick-image");
  const cacheRoot = path.join(codexHome, "plugins", "cache", "quick-image", "quick-image", "0.2.1");
  const codexManifestPaths = [];
  for (const pluginRoot of [marketplaceRoot, cacheRoot]) {
    await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "quick-image",
      version: "0.2.1",
      mcpServers: "./.mcp.json"
    }));
    for (const fileName of [".mcp.json", "mcp.json"]) codexManifestPaths.push(path.join(pluginRoot, fileName));
  }
  const originalCodexManifest = `${JSON.stringify({
    mcpServers: {
      "quick-image": {
        type: "http",
        url: "https://quickimage.ai/mcp",
        headers: {
          "X-Quick-Image-Plugin-Version": "0.2.1",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        },
        http_headers: {
          "X-Quick-Image-Plugin-Version": "0.2.1",
          "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
        }
      }
    }
  }, null, 2)}\n`;
  await Promise.all(codexManifestPaths.map((manifestPath) => writeFile(manifestPath, originalCodexManifest)));

  const codexBin = path.join(root, "codex-fixture.mjs");
  await writeFile(codexBin, [
    "#!/usr/bin/env node",
    "const fs = await import('node:fs');",
    "const path = await import('node:path');",
    "const args = process.argv.slice(2);",
    "const cacheManifest = path.join(process.env.CODEX_HOME, 'plugins', 'cache', 'quick-image', 'quick-image', '0.2.1', '.mcp.json');",
    "if (args[0] === 'plugin' && args[1] === 'list') {",
    "  process.stdout.write(JSON.stringify({ installed: [{",
    "    pluginId: 'quick-image@quick-image',",
    "    name: 'quick-image',",
    "    marketplaceName: 'quick-image',",
    "    version: '0.2.1',",
    "    enabled: true,",
    "    source: { source: 'local', path: path.join(process.env.CODEX_HOME, '.tmp', 'marketplaces', 'quick-image') }",
    "  }] }));",
    "} else if (args[0] === 'mcp' && args[1] === 'get') {",
    "  const entry = JSON.parse(fs.readFileSync(cacheManifest, 'utf8')).mcpServers['quick-image'];",
    "  process.stdout.write(JSON.stringify({ transport: {",
    "    url: entry.url,",
    "    http_headers: {",
    "      'X-Quick-Image-Plugin-Version': '0.2.1',",
    "      'X-Quick-Image-Frontend-URL': entry.headers['X-Quick-Image-Frontend-URL']",
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
  for (const manifestPath of codexManifestPaths) {
    const updated = JSON.parse(await readFile(manifestPath, "utf8"));
    if (updated.mcpServers["quick-image"].url !== "https://staging-api.example.com/mcp" ||
        updated.mcpServers["quick-image"].headers?.["X-Quick-Image-Frontend-URL"] !== "https://staging.example.com") {
      throw new Error(`environment CLI did not update the Codex plugin manifest: ${manifestPath}`);
    }
    if (await readFile(`${manifestPath}.quick-image-backup`, "utf8").then((content) => content !== originalCodexManifest).catch(() => true)) {
      throw new Error(`environment CLI did not back up the Codex plugin manifest: ${manifestPath}`);
    }
  }
  if (await readFile(codexConfigPath, "utf8").then((content) => content !== originalCodexConfig).catch(() => true)) {
    throw new Error("environment CLI unexpectedly modified Codex config.toml");
  }

  const resetResult = spawnSync(process.execPath, [
    path.join(process.cwd(), "dist", "cli", "quick-image.js"),
    "env",
    "reset",
    "--host",
    "codex",
    "--codex-bin",
    codexBin
  ], { encoding: "utf8", env: { ...process.env, CODEX_HOME: codexHome } });
  if (resetResult.status !== 0) {
    throw new Error(`environment reset CLI failed: ${(resetResult.stderr || resetResult.stdout).trim()}`);
  }
  for (const manifestPath of codexManifestPaths) {
    const restored = JSON.parse(await readFile(manifestPath, "utf8"));
    if (restored.mcpServers["quick-image"].url !== "https://quickimage.ai/mcp" ||
        restored.mcpServers["quick-image"].headers?.["X-Quick-Image-Frontend-URL"] !== "https://quickimage.ai") {
      throw new Error(`environment reset CLI did not restore the Codex plugin manifest: ${manifestPath}`);
    }
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
