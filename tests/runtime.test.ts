import { describe, expect, it } from "vitest";
import { assertSupportedRuntime } from "../src/runtime.js";

describe("runtime support", () => {
  it("allows native Windows while retaining the shared runtime checks", () => {
    expect(() => assertSupportedRuntime("win32")).not.toThrow();
  });
});
