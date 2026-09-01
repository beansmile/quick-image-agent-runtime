import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOpenClawToolPolicy } from "../src/cli/openclaw-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OpenClaw Quick Image tool policy", () => {
  it("rejects restrictive profiles that hide the native adapter tools", async () => {
    const fixture = await createFixture({ tools: { profile: "coding" } });
    await expect(checkOpenClawToolPolicy(fixture.configPath)).rejects.toThrow("quick_image_list_attachments");
  });

  it("accepts a plugin-scoped grant without the generic message tool", async () => {
    const fixture = await createFixture({ tools: { profile: "coding", alsoAllow: ["quick-image"] } });
    await expect(checkOpenClawToolPolicy(fixture.configPath)).resolves.toBeUndefined();
  });

  it("accepts the plugin-scoped grant with a minimal profile", async () => {
    const fixture = await createFixture({ tools: { profile: "minimal", alsoAllow: ["quick-image"] } });
    await expect(checkOpenClawToolPolicy(fixture.configPath)).resolves.toBeUndefined();
  });

  it("rejects an explicit deny even when the plugin is allowed", async () => {
    const fixture = await createFixture({
      tools: { profile: "coding", alsoAllow: ["quick-image"], deny: ["quick_image_send_preview"] }
    });
    await expect(checkOpenClawToolPolicy(fixture.configPath)).rejects.toThrow("quick_image_send_preview");
  });
});

async function createFixture(config: Record<string, unknown>) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "quick-image-openclaw-policy-"));
  temporaryDirectories.push(stateDirectory);
  const configPath = path.join(stateDirectory, "openclaw.json");
  await writeFile(configPath, JSON.stringify(config));
  return { configPath };
}
