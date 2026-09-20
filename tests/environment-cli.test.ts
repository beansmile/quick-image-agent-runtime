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
import { checkEnvironmentProduction } from "../src/environment/service.js";

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

describe("production environment check", () => {
  it("reports production status for both hosts without exposing any URL", async () => {
    const directory = await temporaryDirectory();
    const codexHome = path.join(directory, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), [
      'model = "gpt-test"\n',
      "# BEGIN quick-image managed MCP environment\n",
      '[mcp_servers.quick-image]\n',
      'url = "https://staging-api.example.com/mcp"\n',
      "# END quick-image managed MCP environment\n"
    ].join(""));
    vi.stubEnv("CODEX_HOME", codexHome);
    const executor: CommandExecutor = {
      run: vi.fn((_executable, args) => {
        if (args[0] === "mcp" && args[1] === "get") {
          return {
            stdout: JSON.stringify({
              transport: {
                url: "https://staging-api.example.com/mcp",
                http_headers: {
                  "X-Quick-Image-Plugin-Version": "0.1.0",
                  "X-Quick-Image-Frontend-URL": "https://staging.example.com"
                }
              }
            }),
            stderr: ""
          };
        }
        throw new Error("Config path not found");
      })
    };

    const report = await checkEnvironmentProduction({
      runtimeVersion: "0.1.0",
      codexBin: "/bin/echo",
      openClawBin: "/bin/echo",
      executor
    });

    expect(report.hosts).toEqual([
      { host: "codex", available: true, is_production: false, source: "custom" },
      { host: "openclaw", available: true, is_production: null, source: "missing" }
    ]);
    expect(JSON.stringify(report)).not.toContain("staging");
  });

  it("marks the production defaults as production", async () => {
    const directory = await temporaryDirectory();
    vi.stubEnv("CODEX_HOME", path.join(directory, ".codex"));
    const executor = codexExecutor(() => productionEnvironmentUrls());
    const report = await checkEnvironmentProduction({
      runtimeVersion: "0.1.0",
      codexBin: "/bin/echo",
      openClawBin: "/nonexistent-openclaw-bin",
      executor
    });

    expect(report.hosts[0]).toEqual({ host: "codex", available: true, is_production: true, source: "plugin-default" });
    expect(report.hosts[1]).toEqual({ host: "openclaw", available: false, is_production: null, source: "unavailable" });
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
