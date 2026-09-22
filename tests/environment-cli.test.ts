import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import {
  containsManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  removeCodexManagedBlock,
  resetCodexEnvironment,
  setCodexEnvironment,
  upsertCodexManagedBlock
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

describe("Codex managed MCP override", () => {
  const urls = {
    serverUrl: "https://staging-api.example.com/mcp",
    frontendUrl: "https://staging.example.com"
  };

  it("adds, replaces, and removes only the marked Quick Image block", () => {
    const original = 'model = "gpt-test"\n';
    const added = upsertCodexManagedBlock(original, urls, "0.1.0");
    expect(containsManagedBlock(added)).toBe(true);
    expect(added).toContain('url = "https://staging-api.example.com/mcp"');
    expect(added).toContain('"X-Quick-Image-Frontend-URL" = "https://staging.example.com"');

    const replaced = upsertCodexManagedBlock(added, {
      serverUrl: "http://127.0.0.1:3000/mcp",
      frontendUrl: "http://127.0.0.1:8001"
    }, "0.2.0");
    expect(replaced.match(/BEGIN quick-image/g)).toHaveLength(1);
    expect(replaced).not.toContain("staging-api.example.com");
    expect(removeCodexManagedBlock(replaced)).toBe(original);
  });

  it("refuses to overwrite an unowned Quick Image table or broken markers", () => {
    expect(() => upsertCodexManagedBlock(
      '[mcp_servers."quick-image"]\nurl = "https://example.com/mcp"\n',
      urls,
      "0.1.0"
    )).toThrow("非 Quick Image 管理");
    // 孤立标记且无指纹表体：无法识别归属，set 拒绝、contains 报告不存在
    expect(() => upsertCodexManagedBlock(
      "# BEGIN quick-image managed MCP environment\n",
      urls,
      "0.1.0"
    )).toThrow("标记不完整或重复");
    expect(containsManagedBlock("# BEGIN quick-image managed MCP environment\n")).toBe(false);
    // 带两个 Quick Image 私有头的手写表（含 oauth_resource 但与 url 不同值）
    // 视为 Quick Image 自定义配置：set 救援替换而非拒绝
    const handWritten = [
      "[mcp_servers.quick-image]",
      'url = "https://a.example.com/mcp"',
      'oauth_resource = "https://b.example.com/mcp"',
      'http_headers = { "X-Quick-Image-Plugin-Version" = "9.9.9", "X-Quick-Image-Frontend-URL" = "https://c.example.com" }',
      ""
    ].join("\n");
    const taken = upsertCodexManagedBlock(handWritten, urls, "0.1.0");
    expect(taken.match(/BEGIN quick-image/g)).toHaveLength(1);
    expect(taken).not.toContain("a.example.com");
    expect(removeCodexManagedBlock(taken)).toBe("");
  });

  it("repairs a damaged block using the table fingerprint", () => {
    const original = 'model = "gpt-test"\n';
    const added = upsertCodexManagedBlock(original, urls, "0.1.0");

    // 场景一：END 标记行被删除，表体残留
    const missingEnd = added.split("\n").filter((line) => line !== MANAGED_BLOCK_END).join("\n");
    const repairedBySet = upsertCodexManagedBlock(missingEnd, {
      serverUrl: "http://127.0.0.1:3000/mcp",
      frontendUrl: "http://127.0.0.1:8001"
    }, "0.2.0");
    expect(repairedBySet.match(/BEGIN quick-image/g)).toHaveLength(1);
    expect(repairedBySet).not.toContain("staging-api.example.com");
    expect(repairedBySet).toContain('url = "http://127.0.0.1:3000/mcp"');
    expect(removeCodexManagedBlock(repairedBySet)).toBe(original);

    // 场景二：两个标记行都被删除，只剩指纹表体
    const noMarkers = added.split("\n").filter((line) =>
      line !== MANAGED_BLOCK_BEGIN && line !== MANAGED_BLOCK_END
    ).join("\n");
    expect(containsManagedBlock(noMarkers)).toBe(true);
    expect(removeCodexManagedBlock(noMarkers)).toBe(original);
    expect(() => upsertCodexManagedBlock(noMarkers, urls, "0.1.0")).not.toThrow();
  });

  it("repairs a block whose inline headers were expanded into sub-tables", () => {
    // 第三方 TOML 重写工具可能把 http_headers 内联表展开成子表；
    // 救援必须连同子表一起清理，且不波及后续其他表。
    const expanded = [
      'model = "gpt-test"\n\n',
      "[mcp_servers.quick-image]\n",
      'url = "https://staging-api.example.com/mcp"\n',
      'oauth_resource = "https://staging-api.example.com/mcp"\n',
      'auth = "oauth"\n',
      "[mcp_servers.quick-image.http_headers]\n",
      '"X-Quick-Image-Plugin-Version" = "0.1.0"\n',
      '"X-Quick-Image-Frontend-URL" = "https://staging.example.com"\n\n',
      "[mcp_servers.other]\n",
      'key = "value"\n'
    ].join("");
    expect(containsManagedBlock(expanded)).toBe(true);
    const removed = removeCodexManagedBlock(expanded);
    expect(removed).toBe('model = "gpt-test"\n\n[mcp_servers.other]\nkey = "value"\n');
    expect(() => upsertCodexManagedBlock(expanded, urls, "0.1.0")).not.toThrow();
  });

  it("rescue leaves content outside the repaired section byte-identical", () => {
    // 多行字符串内部的连续空行、逐字引用的标记文本，以及接缝处原有的空行
    // 都属于区块外内容，救援不得改动；只有被删除的表本身可以消失。
    const source = [
      'model = "gpt-test"\n',
      `prompt = """\n${MANAGED_BLOCK_BEGIN}\nkeep\n\n\nme\n"""\n`,
      "[mcp_servers.quick-image]\n",
      'url = "https://staging-api.example.com/mcp"\n',
      'oauth_resource = "https://staging-api.example.com/mcp"\n',
      'auth = "oauth"\n',
      'http_headers = { "X-Quick-Image-Plugin-Version" = "0.1.0", "X-Quick-Image-Frontend-URL" = "https://staging.example.com" }\n',
      "[mcp_servers.other]\n",
      'notes = """\npara one\n\n\npara two\n"""\n'
    ].join("");
    const removed = removeCodexManagedBlock(source);
    expect(removed).toBe([
      'model = "gpt-test"\n',
      `prompt = """\n${MANAGED_BLOCK_BEGIN}\nkeep\n\n\nme\n"""\n`,
      "[mcp_servers.other]\n",
      'notes = """\npara one\n\n\npara two\n"""\n'
    ].join(""));
    expect(() => upsertCodexManagedBlock(source, urls, "0.1.0")).not.toThrow();
  });

  it("writes an atomic user override and reset falls back to the plugin defaults", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    await writeFile(configPath, 'model = "gpt-test"\n');
    let effective = urls;
    const executor = codexExecutor(() => effective);

    const status = await setCodexEnvironment(urls, {
      runtimeVersion: "0.1.0",
      codexBin: "/bin/echo",
      configPath,
      executor
    });
    expect(status).toMatchObject({ host: "codex", source: "custom", ...urls });
    await expect(readFile(configPath, "utf8")).resolves.toContain("BEGIN quick-image managed MCP environment");
    await expect(readFile(`${configPath}.quick-image-backup`, "utf8")).resolves.toBe('model = "gpt-test"\n');

    effective = productionEnvironmentUrls();
    const reset = await resetCodexEnvironment({
      runtimeVersion: "0.1.0",
      codexBin: "/bin/echo",
      configPath,
      executor
    });
    expect(reset).toMatchObject({ host: "codex", source: "plugin-default", ...effective });
    await expect(readFile(configPath, "utf8")).resolves.toBe('model = "gpt-test"\n');
  });

  it("restores the original file and keeps the backup when verification fails", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    await writeFile(configPath, 'model = "gpt-test"\n');
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        if (args[0] === "mcp" && args[1] === "get") {
          return {
            stdout: JSON.stringify({
              transport: {
                url: "https://unexpected.example.com/mcp",
                http_headers: {
                  "X-Quick-Image-Plugin-Version": "0.1.0",
                  "X-Quick-Image-Frontend-URL": "https://unexpected.example.com"
                }
              }
            }),
            stderr: ""
          };
        }
        return { stdout: "[]", stderr: "" };
      })
    };

    await expect(setCodexEnvironment(urls, {
      runtimeVersion: "0.1.0",
      codexBin: "/bin/echo",
      configPath,
      executor
    })).rejects.toThrow("未加载刚写入");
    await expect(readFile(configPath, "utf8")).resolves.toBe('model = "gpt-test"\n');
    await expect(readFile(`${configPath}.quick-image-backup`, "utf8")).resolves.toBe('model = "gpt-test"\n');
  });

  it("reset restores legacy manifest overrides back to production defaults", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    const marketplaceRoot = path.join(codexHome, ".tmp", "marketplaces", "quick-image");
    const cacheRoot = path.join(codexHome, "plugins", "cache", "quick-image", "quick-image", "0.1.0");
    vi.stubEnv("CODEX_HOME", codexHome);
    await Promise.all([marketplaceRoot, cacheRoot].map((root) => writeContaminatedPluginFixture(root)));
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        if (args[0] === "plugin" && args[1] === "list") {
          return {
            stdout: JSON.stringify({
              installed: [{
                pluginId: "quick-image@quick-image",
                name: "quick-image",
                marketplaceName: "quick-image",
                version: "0.1.0",
                enabled: true,
                source: { source: "local", path: marketplaceRoot }
              }]
            }),
            stderr: ""
          };
        }
        if (args[0] === "mcp" && args[1] === "get") {
          const manifest = JSON.parse(readFileSync(path.join(cacheRoot, ".mcp.json"), "utf8"));
          const server = manifest.mcpServers["quick-image"];
          return {
            stdout: JSON.stringify({
              transport: {
                url: server.url,
                http_headers: {
                  "X-Quick-Image-Plugin-Version": "0.1.0",
                  "X-Quick-Image-Frontend-URL": server.http_headers["X-Quick-Image-Frontend-URL"]
                }
              }
            }),
            stderr: ""
          };
        }
        return { stdout: "[]", stderr: "" };
      })
    };

    const reset = await resetCodexEnvironment({ runtimeVersion: "0.1.0", codexBin: "/bin/echo", executor });
    expect(reset).toMatchObject({ host: "codex", source: "plugin-default", ...productionEnvironmentUrls() });
    for (const root of [marketplaceRoot, cacheRoot]) {
      for (const fileName of [".mcp.json", "mcp.json"]) {
        const manifest = JSON.parse(await readFile(path.join(root, fileName), "utf8"));
        expect(manifest.mcpServers["quick-image"]).toMatchObject({
          url: "https://quickimage.ai/mcp",
          headers: { "X-Quick-Image-Frontend-URL": "https://quickimage.ai" },
          http_headers: { "X-Quick-Image-Frontend-URL": "https://quickimage.ai" }
        });
      }
    }
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
    const originalText = await readFile(fixture.mcpPath, "utf8");

    const status = await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    expect(status).toMatchObject({ host: "workbuddy", source: "custom", ...stagingUrls });

    const updated = JSON.parse(await readFile(fixture.mcpPath, "utf8"));
    expect(updated.mcpServers["quick-image"]).toMatchObject({
      type: "http",
      url: stagingUrls.serverUrl,
      headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl },
      http_headers: { "X-Quick-Image-Frontend-URL": stagingUrls.frontendUrl }
    });
    expect(JSON.parse(originalText).mcpServers["quick-image-local"]).toEqual(updated.mcpServers["quick-image-local"]);
    await expect(readFile(`${fixture.mcpPath}.quick-image-backup`, "utf8")).resolves.toBe(originalText);

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
    const updated = JSON.parse(await readFile(fixture.mcpPath, "utf8"));
    expect(updated.mcpServers["quick-image"].url).toBe(stagingUrls.serverUrl);
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

  it("leaves the manifest untouched when it lacks the quick-image entry or is broken", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");

    const missingEntry = await writeWorkBuddyFixture(workBuddyHome, {
      registryKey: "quick-image@quick-image",
      mcpContent: JSON.stringify({ mcpServers: { "other-server": { type: "stdio", command: "npx" } } })
    });
    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("缺少 quick-image 配置");
    await expect(readFile(missingEntry.mcpPath, "utf8")).resolves.toBe(missingEntry.originalText);

    const broken = await writeWorkBuddyFixture(workBuddyHome, {
      installPathSuffix: "broken",
      mcpContent: "{ not json"
    });
    await expect(setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome }))
      .rejects.toThrow("不是有效 JSON");
    await expect(readFile(broken.mcpPath, "utf8")).resolves.toBe(broken.originalText);
  });

  it("preserves the byte order mark and trailing newline style of the original file", async () => {
    const directory = await temporaryDirectory();
    const workBuddyHome = path.join(directory, ".workbuddy");
    const fixture = await writeWorkBuddyFixture(workBuddyHome, {
      byteOrderMark: true,
      trailingNewline: false
    });

    await setWorkBuddyEnvironment(stagingUrls, { workbuddyHome: workBuddyHome });
    const rewritten = await readFile(fixture.mcpPath, "utf8");
    expect(rewritten.charCodeAt(0)).toBe(0xfeff);
    expect(rewritten.endsWith("\n")).toBe(false);
    // BOM 由读取方剥离（parseWorkBuddyManifestText），剥离后必须仍是有效 JSON。
    expect(() => JSON.parse(rewritten.slice(1))).not.toThrow();
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
    expect(serializeWorkBuddyManifestText(value, "\uFEFF{}\n")).toBe(`\uFEFF${JSON.stringify(value, null, 2)}\n`);
    expect(serializeWorkBuddyManifestText(value, "{}")).toBe(JSON.stringify(value, null, 2));
  });
});

function codexExecutor(urls: () => { serverUrl: string; frontendUrl: string }): CommandExecutor {
  return {
    run: vi.fn((_executable, args) => {
      if (args[0] === "mcp" && args[1] === "get") {
        return {
          stdout: JSON.stringify({
            transport: {
              url: urls().serverUrl,
              http_headers: {
                "X-Quick-Image-Plugin-Version": "0.1.0",
                "X-Quick-Image-Frontend-URL": urls().frontendUrl
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quick-image-env-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface WorkBuddyFixture {
  mcpPath: string;
  originalText: string;
}

interface WorkBuddyFixtureOptions {
  manifest?: ".workbuddy-plugin" | ".codebuddy-plugin";
  mcpServers?: string;
  mcpContent?: string;
  registryKey?: string;
  installPathSuffix?: string;
  byteOrderMark?: boolean;
  trailingNewline?: boolean;
}

async function writeWorkBuddyFixture(home: string, options: WorkBuddyFixtureOptions): Promise<WorkBuddyFixture> {
  const manifestDir = options.manifest ?? ".workbuddy-plugin";
  const mcpFileName = manifestDir === ".workbuddy-plugin" ? ".mcp.json" : "mcp.json";
  const registryKey = options.registryKey ?? "quick-image@quick-image";
  const root = path.join(home, "plugins", "cache", "quick-image", "quick-image", options.installPathSuffix ?? "0.1.8");
  await mkdir(path.join(root, manifestDir), { recursive: true });
  await writeFile(path.join(root, manifestDir, "plugin.json"), JSON.stringify({
    name: "quick-image",
    version: "0.1.8",
    skills: "./skills/",
    mcpServers: options.mcpServers ?? `./${mcpFileName}`
  }));
  const mcpPath = path.join(root, mcpFileName);
  const mcpValue = options.mcpContent === undefined
    ? {
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
      }
    : options.mcpContent;
  const serialized = typeof mcpValue === "string" ? mcpValue : JSON.stringify(mcpValue, null, 2);
  const originalText = `${options.byteOrderMark ? "\uFEFF" : ""}${serialized}${options.trailingNewline === false ? "" : "\n"}`;
  await writeFile(mcpPath, originalText);
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
  return { mcpPath, originalText };
}

async function writeContaminatedPluginFixture(root: string): Promise<void> {
  await mkdir(path.join(root, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "quick-image",
    version: "0.1.0",
    mcpServers: "./.mcp.json"
  }));
  const manifest = JSON.stringify({
    mcpServers: {
      "quick-image": {
        type: "http",
        url: "https://staging-api.example.com/mcp",
        headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0",
          "X-Quick-Image-Frontend-URL": "https://staging.example.com"
        },
        http_headers: {
          "X-Quick-Image-Plugin-Version": "0.1.0",
          "X-Quick-Image-Frontend-URL": "https://staging.example.com"
        }
      }
    }
  });
  await Promise.all([
    writeFile(path.join(root, ".mcp.json"), manifest),
    writeFile(path.join(root, "mcp.json"), manifest)
  ]);
}
