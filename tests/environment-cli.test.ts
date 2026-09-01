import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../src/environment/command-executor.js";
import {
  containsManagedBlock,
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

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
    expect(() => containsManagedBlock("# BEGIN quick-image managed MCP environment\n")).toThrow("标记不完整");
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
      ["gateway", "restart"],
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
      ["gateway", "restart"],
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
