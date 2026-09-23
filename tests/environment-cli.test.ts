import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import {
  readCodexEnvironmentStatus,
  resetCodexEnvironment,
  setCodexEnvironment
} from "../src/environment/codex.js";
import {
  buildOpenClawMcpConfig,
  normalizeEnvironmentUrls,
  productionEnvironmentUrls,
  validateFrontendUrl,
  validateServerUrl
} from "../src/environment/config.js";
import { setOpenClawEnvironment } from "../src/environment/openclaw.js";
import {
  applyWorkBuddyMcpUrls,
  resetWorkBuddyEnvironment,
  readWorkBuddyEnvironmentStatus,
  serializeWorkBuddyManifestText,
  setWorkBuddyEnvironment,
  verifyWorkBuddyManifest
} from "../src/environment/workbuddy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Quick Image environment URL validation", () => {
  it("accepts HTTPS remote URLs and loopback HTTP URLs", () => {
    expect(normalizeEnvironmentUrls(
      "https://staging-api.example.com/mcp",
      "https://staging.example.com"
    )).toEqual({
      serverUrl: "https://staging-api.example.com/mcp",
      frontendUrl: "https://staging.example.com"
    });
    expect(validateServerUrl("http://127.0.0.1:3000/mcp")).toBe("http://127.0.0.1:3000/mcp");
    expect(validateFrontendUrl("http://localhost:8001")).toBe("http://localhost:8001");
  });

  it.each([
    ["http://staging-api.example.com/mcp", "https://staging.example.com"],
    ["https://staging-api.example.com/api", "https://staging.example.com"],
    ["https://staging-api.example.com/mcp?token=test", "https://staging.example.com"],
    ["https://staging-api.example.com/mcp", "https://staging.example.com/path"]
  ])("rejects unsafe or malformed URL pairs", (serverUrl, frontendUrl) => {
    expect(() => normalizeEnvironmentUrls(serverUrl, frontendUrl)).toThrow();
  });

  it("builds the production OpenClaw MCP config without an environment label", () => {
    expect(buildOpenClawMcpConfig(productionEnvironmentUrls(), "0.1.0")).toEqual({
      transport: "streamable-http",
      url: "https://quickimage.ai/mcp",
      auth: "oauth",
      oauth: { scope: "presets:read assets:write tasks:read tasks:write" },
      headers: {
        "X-Quick-Image-Plugin-Version": "0.1.0",
        "X-Quick-Image-Frontend-URL": "https://quickimage.ai"
      }
    });
  });
});

describe("Codex environment adapter", () => {
  const stagingUrls = {
    serverUrl: "https://staging-api.example.com/mcp",
    frontendUrl: "https://staging.example.com"
  };

  it("updates both manifests in the marketplace copy and the install cache", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const fixture = await writeCodexFixture(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    const executor = codexManifestExecutor(fixture);

    const status = await setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor });
    expect(status).toMatchObject({ host: "codex", source: "custom", ...stagingUrls });
    for (const mcpPath of fixture.mcpPaths) {
      const updated = JSON.parse(await readFile(mcpPath, "utf8"));
      expect(updated.mcpServers["quick-image"]).toMatchObject({
        url: stagingUrls.serverUrl,
        headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl },
        http_headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl }
      });
      expect(updated.mcpServers["quick-image-local"]).toEqual(defaultCodexMcpValue().mcpServers["quick-image-local"]);
      await expect(readFile(`${mcpPath}.quick-image-backup`, "utf8")).resolves.toBe(fixture.originalText);
    }

    const reset = await resetCodexEnvironment({ codexBin: "/bin/echo", executor });
    expect(reset).toMatchObject({ host: "codex", source: "plugin-default", ...productionEnvironmentUrls() });
    for (const mcpPath of fixture.mcpPaths) {
      const restored = JSON.parse(await readFile(mcpPath, "utf8"));
      expect(restored.mcpServers["quick-image"].url).toBe("https://quickimage.ai/mcp");
    }
  });

  it("leaves every manifest untouched when a later manifest cannot be parsed", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const fixture = await writeCodexFixture(codexHome);
    await writeFile(fixture.mcpPaths[3]!, "{ not json");
    vi.stubEnv("CODEX_HOME", codexHome);

    await expect(setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor: codexManifestExecutor(fixture) }))
      .rejects.toThrow("不是有效 JSON");
    await expect(readFile(fixture.mcpPaths[0]!, "utf8")).resolves.toBe(fixture.originalText);
  });

  it("leaves the manifest untouched when it lacks the quick-image entry", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const fixture = await writeCodexFixture(codexHome, {
      cacheMcpContent: `${JSON.stringify({ mcpServers: { "other-server": { type: "stdio", command: "npx" } } })}\n`
    });
    vi.stubEnv("CODEX_HOME", codexHome);

    await expect(setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor: codexManifestExecutor(fixture) }))
      .rejects.toThrow("缺少 quick-image 配置");
    await expect(readFile(fixture.mcpPaths[0]!, "utf8")).resolves.toBe(fixture.originalText);
  });

  it("restores already-written manifests when a later root fails to write", async () => {
    // root 用户不受目录只读位约束；Windows 目录只读属性不阻止在其中创建与
    // 重命名文件。两者都无法触发写入失败，跳过该路径。
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const fixture = await writeCodexFixture(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    // 只读的缓存目录让解析照常进行，但写入其中清单时失败，触发已写入的
    // marketplace 清单回滚。
    await chmod(fixture.cacheRoot, 0o500);
    try {
      await expect(setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor: codexManifestExecutor(fixture) }))
        .rejects.toThrow();
      for (const mcpPath of fixture.mcpPaths.slice(0, 2)) {
        await expect(readFile(mcpPath, "utf8")).resolves.toBe(fixture.originalText);
      }
    } finally {
      await chmod(fixture.cacheRoot, 0o700);
    }
  });

  it("keeps the written manifests and reports when Codex loads other URLs", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const fixture = await writeCodexFixture(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    const executor = codexManifestExecutor(fixture, () => ({
      serverUrl: "https://other.example.com/mcp",
      frontendUrl: "https://other.example.com"
    }));

    await expect(setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor }))
      .rejects.toThrow("未加载刚写入");
    // 清单内容正确、不因外部覆盖回滚：冲突来源在宿主用户级配置。
    const updated = JSON.parse(await readFile(fixture.mcpPaths[2]!, "utf8"));
    expect(updated.mcpServers["quick-image"].url).toBe(stagingUrls.serverUrl);
  });

  it("reports missing and refuses to set when the plugin is not installed", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    vi.stubEnv("CODEX_HOME", codexHome);
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        if (args[0] === "plugin") return { stdout: JSON.stringify({ installed: [] }), stderr: "" };
        throw new Error("mcp not found");
      })
    };

    await expect(readCodexEnvironmentStatus({ codexBin: "/bin/echo", executor })).resolves.toEqual({
      host: "codex",
      configured: false,
      source: "missing"
    });
    await expect(setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor }))
      .rejects.toThrow("无法从 Codex Plugin 列表定位");
  });

  it("preserves minified formatting without adding a trailing newline", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const minified = JSON.stringify(defaultCodexMcpValue());
    const fixture = await writeCodexFixture(codexHome, { mcpContent: minified });
    vi.stubEnv("CODEX_HOME", codexHome);

    await setCodexEnvironment(stagingUrls, { codexBin: "/bin/echo", executor: codexManifestExecutor(fixture) });
    const rewritten = await readFile(fixture.mcpPaths[0]!, "utf8");
    expect(rewritten.endsWith("\n")).toBe(false);
    expect(rewritten).toBe(JSON.stringify(JSON.parse(rewritten)));
  });
});

describe("OpenClaw environment adapter", () => {
  it("uses only official OpenClaw configuration and refresh commands", async () => {
    const calls: string[][] = [];
    const urls = {
      serverUrl: "https://staging-api.example.com/mcp",
      frontendUrl: "https://staging.example.com"
    };
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        calls.push(args);
        if (args[0] === "config") {
          return {
            stdout: JSON.stringify({
              ...buildOpenClawMcpConfig(urls, "0.1.0"),
              custom_timeout_ms: 5000
            }),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      })
    };

    const status = await setOpenClawEnvironment(urls, {
      runtimeVersion: "0.1.0",
      openClawBin: "/bin/echo",
      executor
    });

    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["config", "get"],
      ["mcp", "set"],
      ["mcp", "reload"],
      ["config", "get"]
    ]);
    expect(JSON.parse(calls[1]![3]!)).toMatchObject({
      custom_timeout_ms: 5000,
      headers: { "X-Quick-Image-Plugin-Version": "0.1.0" }
    });
    expect(status).toMatchObject({ host: "openclaw", source: "custom", ...urls });
  });

  it("refuses to create a missing OpenClaw MCP configuration", async () => {
    const executor: CommandExecutor = {
      run: vi.fn(() => {
        throw new Error("Config path not found");
      })
    };

    await expect(setOpenClawEnvironment({
      serverUrl: "https://staging-api.example.com/mcp",
      frontendUrl: "https://staging.example.com"
    }, {
      runtimeVersion: "0.2.0",
      openClawBin: "/bin/echo",
      executor
    })).rejects.toThrow("请先重新安装 Quick Image Plugin");
  });

  it("rejects when OpenClaw reports a different config after writing", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        calls.push(args);
        if (args[0] === "config" && args[1] === "get") {
          return {
            stdout: JSON.stringify(buildOpenClawMcpConfig({
              serverUrl: "https://other.example.com/mcp",
              frontendUrl: "https://other.example.com"
            }, "0.1.0")),
            stderr: ""
          };
        }
        return { stdout: "", stderr: "" };
      })
    };

    await expect(setOpenClawEnvironment({
      serverUrl: "https://staging-api.example.com/mcp",
      frontendUrl: "https://staging.example.com"
    }, {
      runtimeVersion: "0.2.0",
      openClawBin: "/bin/echo",
      executor
    })).rejects.toThrow("未加载刚写入");
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["config", "get"],
      ["mcp", "set"],
      ["mcp", "reload"],
      ["config", "get"]
    ]);
  });
});

describe("WorkBuddy environment adapter", () => {
  const stagingUrls = {
    serverUrl: "https://staging-api.example.com/mcp",
    frontendUrl: "https://staging.example.com"
  };

  it("updates only the quick-image entry in the plugin MCP manifest", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, {});
    const originalText = await readFile(fixture.mcpPaths[0]!, "utf8");

    const status = await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    expect(status).toMatchObject({ host: "workbuddy", source: "custom", ...stagingUrls });

    const updated = JSON.parse(await readFile(fixture.mcpPaths[0]!, "utf8"));
    expect(updated.mcpServers["quick-image"]).toMatchObject({
      type: "http",
      url: stagingUrls.serverUrl,
      headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl },
      http_headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl }
    });
    expect(JSON.parse(originalText).mcpServers["quick-image-local"]).toEqual(updated.mcpServers["quick-image-local"]);
    await expect(readFile(`${fixture.mcpPaths[0]!}.quick-image-backup`, "utf8")).resolves.toBe(originalText);

    const reset = await resetWorkBuddyEnvironment({ workbuddyHome: workBuddyHome });
    expect(reset).toMatchObject({
      host: "workbuddy",
      source: "plugin-default",
      serverUrl: "https://quickimage.ai/mcp",
      frontendUrl: "https://quickimage.ai"
    });
  });

  it("falls back to the CodeBuddy manifest when no WorkBuddy manifest exists", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, { manifest: ".codebuddy-plugin" });

    const status = await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    expect(status).toMatchObject({ host: "workbuddy", source: "custom", ...stagingUrls });
    const updated = JSON.parse(await readFile(fixture.mcpPaths[0]!, "utf8"));
    expect(updated.mcpServers["quick-image"].url).toBe(stagingUrls.serverUrl);
  });

  it("updates both plugin manifests when both layouts ship in one install", async () => {
    // 新版 WorkBuddy 客户端还会加载 .codebuddy-plugin 布局指向的 mcp.json；
    // set/reset 必须同步改写两份清单，否则宿主可能加载到混合环境。
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, { manifest: "both" });

    const status = await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    expect(status).toMatchObject({ host: "workbuddy", source: "custom", ...stagingUrls });
    for (const mcpPath of fixture.mcpPaths) {
      const updated = JSON.parse(await readFile(mcpPath, "utf8"));
      expect(updated.mcpServers["quick-image"]).toMatchObject({
        url: stagingUrls.serverUrl,
        headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl },
        http_headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl }
      });
      await expect(readFile(`${mcpPath}.quick-image-backup`, "utf8")).resolves.toBe(fixture.originalText);
    }

    const reset = await resetWorkBuddyEnvironment({ workbuddyHome: workBuddyHome });
    expect(reset).toMatchObject({
      host: "workbuddy",
      source: "plugin-default",
      serverUrl: "https://quickimage.ai/mcp",
      frontendUrl: "https://quickimage.ai"
    });
    for (const mcpPath of fixture.mcpPaths) {
      const restored = JSON.parse(await readFile(mcpPath, "utf8"));
      expect(restored.mcpServers["quick-image"].url).toBe("https://quickimage.ai/mcp");
    }
  });

  it("leaves every manifest untouched when the new-layout manifest lacks the entry", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, { manifest: "both" });
    await writeFile(fixture.mcpPaths[1]!, JSON.stringify({
      mcpServers: { "other-server": { type: "stdio", command: "npx" } }
    }));

    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("缺少 quick-image 配置");
    await expect(readFile(fixture.mcpPaths[0]!, "utf8")).resolves.toBe(fixture.originalText);
  });

  it("reports missing and refuses to set when the plugin is not registered", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    await mkdir(workBuddyHome, { recursive: true });

    await expect(readWorkBuddyEnvironmentStatus({ workbuddyHome: workBuddyHome })).resolves.toEqual({
      host: "workbuddy",
      configured: false,
      source: "missing"
    });
    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("在 WorkBuddy 中找不到 quick-image 插件安装");
  });

  it("refuses manifest paths that escape the plugin directory", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    await writeWorkBuddyFixture(workBuddyHome, { mcpServers: "../outside.json" });

    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("超出插件目录");
  });

  it("leaves every install untouched when a later install cannot be parsed", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, {});
    await appendWorkBuddyInstall(workBuddyHome, "broken", "{ not json");

    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("不是有效 JSON");
    await expect(readFile(fixture.mcpPaths[0]!, "utf8")).resolves.toBe(fixture.originalText);
  });

  it("restores already-written installs when a later install fails to write", async () => {
    // root 用户不受目录只读位约束；Windows 目录只读属性不阻止在其中创建与
    // 重命名文件。两者都无法触发写入失败，跳过该路径。
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, {});
    const lockedRoot = await appendWorkBuddyInstall(workBuddyHome, "locked");
    // 只读目录能让解析与备份读取照常进行，但写入第二个安装时失败，
    // 以此触发“第一个安装已写入”的回滚路径。
    await chmod(lockedRoot, 0o500);
    try {
      await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome })).rejects.toThrow();
      await expect(readFile(fixture.mcpPaths[0]!, "utf8")).resolves.toBe(fixture.originalText);
    } finally {
      await chmod(lockedRoot, 0o700);
    }
  });

  it("leaves the manifest untouched when it lacks the quick-image entry", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const missingEntry = await writeWorkBuddyFixture(workBuddyHome, {
      mcpContent: JSON.stringify({ mcpServers: { "other-server": { type: "stdio", command: "npx" } } })
    });

    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("缺少 quick-image 配置");
    await expect(readFile(missingEntry.mcpPaths[0]!, "utf8")).resolves.toBe(missingEntry.originalText);
  });

  it("reports missing instead of failing when the registry or plugin manifest is unreadable", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    await writeWorkBuddyFixture(workBuddyHome, { manifestContent: "{ not json" });

    await expect(readWorkBuddyEnvironmentStatus({ workbuddyHome: workBuddyHome })).resolves.toEqual({
      host: "workbuddy",
      configured: false,
      source: "missing"
    });
    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("文件不是有效的 JSON 对象");

    const registryPath = path.join(workBuddyHome, "plugins", "installed_plugins.json");
    await writeFile(registryPath, "{ not json");
    await expect(readWorkBuddyEnvironmentStatus({ workbuddyHome: workBuddyHome })).resolves.toEqual({
      host: "workbuddy",
      configured: false,
      source: "missing"
    });
  });

  it("preserves the byte order mark and trailing newline style of the original file", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, {
      byteOrderMark: true,
      trailingNewline: false
    });

    await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    const rewritten = await readFile(fixture.mcpPaths[0]!, "utf8");
    expect(rewritten.charCodeAt(0)).toBe(0xfeff);
    expect(rewritten.endsWith("\n")).toBe(false);
    // BOM 由读取方剥离（parseWorkBuddyManifestText），剥离后必须仍是有效 JSON。
    expect(() => JSON.parse(rewritten.slice(1))).not.toThrow();
  });

  it("preserves CRLF line endings and indentation of the original file", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const crlfText = `${JSON.stringify(defaultWorkBuddyMcpValue(), null, 4).replace(/\n/g, "\r\n")}\r\n`;
    const fixture = await writeWorkBuddyFixture(workBuddyHome, { mcpContent: crlfText, trailingNewline: false });

    await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    const rewritten = await readFile(fixture.mcpPaths[0]!, "utf8");
    const parsed = JSON.parse(rewritten);
    expect(parsed.mcpServers["quick-image"].url).toBe(stagingUrls.serverUrl);
    // 行尾全部保持 CRLF，缩进保持 4 空格：与重新格式化的语义等价文本完全一致。
    expect(rewritten).toBe(`${JSON.stringify(parsed, null, 4).replace(/\n/g, "\r\n")}\r\n`);
  });

  it("creates a headers container when the entry ships without one", () => {
    const manifest = {
      mcpServers: {
        "quick-image": { type: "http", url: "https://quickimage.ai/mcp" }
      }
    };
    const updated = applyWorkBuddyMcpUrls(manifest, stagingUrls);
    expect((updated.mcpServers as Record<string, unknown>)["quick-image"]).toEqual({
      type: "http",
      url: stagingUrls.serverUrl,
      headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl }
    });
    verifyWorkBuddyManifest(manifest, updated, stagingUrls);
  });

  it("detects unexpected changes outside the quick-image entry", () => {
    const manifest = {
      $schema: "https://example.com/schema.json",
      mcpServers: {
        "quick-image": {
          type: "http",
          url: "https://quickimage.ai/mcp",
          headers: { "X-Quick-Image-Frontend-URL": "https://quickimage.ai" }
        },
        "quick-image-local": { type: "stdio", command: "npx" }
      }
    };
    verifyWorkBuddyManifest(manifest, structuredClone(manifest), {
      serverUrl: "https://quickimage.ai/mcp",
      frontendUrl: "https://quickimage.ai"
    });

    const tampered = structuredClone(manifest);
    (tampered.mcpServers["quick-image-local"] as Record<string, unknown>).command = "evil";
    expect(() => verifyWorkBuddyManifest(manifest, tampered, {
      serverUrl: "https://quickimage.ai/mcp",
      frontendUrl: "https://quickimage.ai"
    })).toThrow("quick-image-local 的配置被意外改动");
  });

  it("serializes with a byte order mark only when the original had one", () => {
    const value = { mcpServers: {} };
    expect(serializeWorkBuddyManifestText(value, "\uFEFF{}\n")).toBe(`\uFEFF${JSON.stringify(value)}\n`);
    expect(serializeWorkBuddyManifestText(value, "{}")).toBe(JSON.stringify(value));
  });

  it("preserves CRLF line endings, indentation, and minified formatting", () => {
    const value = { mcpServers: {} };
    expect(serializeWorkBuddyManifestText(value, '{\r\n    "mcpServers": {}\r\n}\r\n'))
      .toBe('{\r\n    "mcpServers": {}\r\n}\r\n');
    expect(serializeWorkBuddyManifestText(value, '{\n\t"mcpServers": {}\n}\n'))
      .toBe(`{\n\t"mcpServers": {}\n}\n`);
    expect(serializeWorkBuddyManifestText(value, '{"mcpServers":{}}\n')).toBe('{"mcpServers":{}}\n');
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quick-image-env-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface WorkBuddyFixture {
  root: string;
  mcpPaths: string[];
  originalText: string;
}

interface WorkBuddyFixtureOptions {
  manifest?: ".workbuddy-plugin" | ".codebuddy-plugin" | "both";
  mcpServers?: string;
  mcpContent?: string;
  manifestContent?: string;
  registryKey?: string;
  installPathSuffix?: string;
  byteOrderMark?: boolean;
  trailingNewline?: boolean;
}

async function writeWorkBuddyFixture(home: string, options: WorkBuddyFixtureOptions): Promise<WorkBuddyFixture> {
  const manifestDirs = options.manifest === "both"
    ? [".workbuddy-plugin", ".codebuddy-plugin"] as const
    : [options.manifest ?? ".workbuddy-plugin"];
  const registryKey = options.registryKey ?? "quick-image@quick-image";
  const root = path.join(home, "plugins", "cache", "quick-image", "quick-image", options.installPathSuffix ?? "0.1.8");
  const mcpPaths: string[] = [];
  for (const manifestDir of manifestDirs) {
    const mcpFileName = manifestDir === ".workbuddy-plugin" ? ".mcp.json" : "mcp.json";
    await mkdir(path.join(root, manifestDir), { recursive: true });
    await writeFile(path.join(root, manifestDir, "plugin.json"), options.manifestContent ?? JSON.stringify({
      name: "quick-image",
      version: "0.1.8",
      skills: "./skills/",
      mcpServers: options.mcpServers ?? `./${mcpFileName}`
    }));
    mcpPaths.push(path.join(root, mcpFileName));
  }
  const serialized = options.mcpContent === undefined
    ? JSON.stringify(defaultWorkBuddyMcpValue(), null, 2)
    : options.mcpContent;
  const originalText = `${options.byteOrderMark ? "\uFEFF" : ""}${serialized}${options.trailingNewline === false ? "" : "\n"}`;
  await Promise.all(mcpPaths.map((mcpPath) => writeFile(mcpPath, originalText)));
  await mkdir(path.join(home, "plugins"), { recursive: true });
  await writeFile(path.join(home, "plugins", "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      [registryKey]: [{
        scope: "user",
        installPath: root,
        version: "0.1.8",
        installedAt: "2026-09-21T15:19:54.090Z",
        lastUpdated: "2026-09-21T15:19:54.090Z"
      }],
      "other-plugin@other-marketplace": [{
        scope: "user",
        installPath: path.join(home, "plugins", "cache", "other-marketplace", "other-plugin", "1.0.0"),
        version: "1.0.0",
        installedAt: "2026-09-21T15:19:54.090Z",
        lastUpdated: "2026-09-21T15:19:54.090Z"
      }]
    }
  }));
  return { root, mcpPaths, originalText };
}

// 追加第二个（不同 scope 的）quick-image 安装并登记进现有注册表，
// 用于覆盖多安装的写入与回滚路径。
async function appendWorkBuddyInstall(home: string, installPathSuffix: string, mcpContent?: string): Promise<string> {
  const root = path.join(home, "plugins", "cache", "quick-image", "quick-image", installPathSuffix);
  await mkdir(path.join(root, ".workbuddy-plugin"), { recursive: true });
  await writeFile(path.join(root, ".workbuddy-plugin", "plugin.json"), JSON.stringify({
    name: "quick-image",
    version: "0.1.8",
    skills: "./skills/",
    mcpServers: "./.mcp.json"
  }));
  await writeFile(path.join(root, ".mcp.json"), mcpContent ?? `${JSON.stringify(defaultWorkBuddyMcpValue(), null, 2)}\n`);
  const registryPath = path.join(home, "plugins", "installed_plugins.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    plugins: Record<string, Array<{ scope: string; installPath: string }> | undefined>;
  };
  const quickImageEntries = registry.plugins["quick-image@quick-image"];
  if (!quickImageEntries) throw new Error("fixture registry is missing the quick-image entry");
  quickImageEntries.push({ scope: "project", installPath: root });
  await writeFile(registryPath, JSON.stringify(registry));
  return root;
}

function defaultWorkBuddyMcpValue() {
  return {
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
  };
}

interface CodexFixture {
  marketplaceRoot: string;
  cacheRoot: string;
  /** [marketplace/.mcp.json, marketplace/mcp.json, cache/.mcp.json, cache/mcp.json] */
  mcpPaths: string[];
  originalText: string;
}

interface CodexFixtureOptions {
  mcpContent?: string;
  cacheMcpContent?: string;
}

async function writeCodexFixture(codexHome: string, options: CodexFixtureOptions = {}): Promise<CodexFixture> {
  const marketplaceRoot = path.join(codexHome, ".tmp", "marketplaces", "quick-image");
  const cacheRoot = path.join(codexHome, "plugins", "cache", "quick-image", "quick-image", "0.2.1");
  const mcpPaths: string[] = [];
  for (const root of [marketplaceRoot, cacheRoot]) {
    await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "quick-image",
      version: "0.2.1",
      mcpServers: "./.mcp.json"
    }));
    for (const fileName of [".mcp.json", "mcp.json"]) mcpPaths.push(path.join(root, fileName));
  }
  const originalText = `${JSON.stringify(defaultCodexMcpValue(), null, 2)}\n`;
  const marketplaceText = options.mcpContent ?? originalText;
  const cacheText = options.cacheMcpContent ?? options.mcpContent ?? originalText;
  await writeFile(mcpPaths[0]!, marketplaceText);
  await writeFile(mcpPaths[1]!, marketplaceText);
  await writeFile(mcpPaths[2]!, cacheText);
  await writeFile(mcpPaths[3]!, cacheText);
  return { marketplaceRoot, cacheRoot, mcpPaths, originalText };
}

// 生效配置的权威来源是安装缓存里的 .mcp.json（与真实 Codex 行为一致），
// executor 据此回报 mcp get；plugin list 的 source.path 指向 marketplace 副本。
function codexManifestExecutor(
  fixture: CodexFixture,
  effectiveUrls?: () => { serverUrl: string; frontendUrl: string }
): CommandExecutor {
  return {
    run: vi.fn((_executable, args) => {
      if (args[0] === "plugin" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            installed: [{
              pluginId: "quick-image@quick-image",
              name: "quick-image",
              marketplaceName: "quick-image",
              version: "0.2.1",
              enabled: true,
              source: { source: "local", path: fixture.marketplaceRoot }
            }]
          }),
          stderr: ""
        };
      }
      if (args[0] === "mcp" && args[1] === "get") {
        const urls = effectiveUrls ? effectiveUrls() : readCodexFixtureUrls(fixture);
        return {
          stdout: JSON.stringify({
            transport: {
              url: urls.serverUrl,
              http_headers: {
                "X-Quick-Image-Plugin-Version": "0.2.1",
                "X-Quick-Image-Frontend-URL": urls.frontendUrl
              }
            }
          }),
          stderr: ""
        };
      }
      return { stdout: "[]", stderr: "" };
    })
  };
}

function readCodexFixtureUrls(fixture: CodexFixture): { serverUrl: string; frontendUrl: string } {
  const manifest = JSON.parse(readFileSync(path.join(fixture.cacheRoot, ".mcp.json"), "utf8"));
  const entry = manifest.mcpServers["quick-image"];
  return { serverUrl: entry.url, frontendUrl: (entry.headers ?? {})["X-Quick-Image-Frontend-URL"] };
}

function defaultCodexMcpValue() {
  return {
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
      },
      "quick-image-local": {
        type: "stdio",
        command: "npx",
        args: ["--yes", "--package", "quick-image-agent-runtime@0.3.0", "quick-image-local-mcp"]
      }
    }
  };
}
