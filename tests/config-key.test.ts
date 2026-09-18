import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { createKeyResolver } from "../src/key.ts";

const originalKey = process.env.TYPESAFE_API_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
});

describe("configuration boundary", () => {
  it("accepts known fields, clamps invalid values to defaults, and ignores secret-shaped extras", () => {
    expect(
      parseConfig({
        enabled: false,
        model: " jev-test ",
        keepThreshold: 2,
        preserveRecentMessages: 3.9,
        cooldownTokens: 100,
        apiKeyCommand: " key-command ",
        apiKey: "must-not-be-read",
      })
    ).toMatchObject({
      enabled: false,
      model: "jev-test",
      keepThreshold: DEFAULT_CONFIG.keepThreshold,
      preserveRecentMessages: 3,
      cooldownTokens: 100,
      apiKeyCommand: "key-command",
    });
  });
});

describe("key resolution", () => {
  it("prefers the environment and caches without invoking a command", async () => {
    process.env.TYPESAFE_API_KEY = " env-secret \n";
    const exec = vi.fn();
    const resolver = createKeyResolver({ exec });
    expect(await resolver.resolve("ignored")).toBe("env-secret");
    expect(await resolver.resolve("ignored")).toBe("env-secret");
    expect(exec).not.toHaveBeenCalled();
  });

  it("runs a configured command once and never includes its output in failures", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const exec = vi.fn().mockResolvedValue({
      stdout: "command-secret\n",
      stderr: "",
      code: 0,
      killed: false,
    });
    const resolver = createKeyResolver({ exec });
    expect(await resolver.resolve("generic-command")).toBe("command-secret");
    expect(await resolver.resolve("generic-command")).toBe("command-secret");
    expect(exec).toHaveBeenCalledTimes(1);

    const failedExec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "command-secret leaked by process",
      code: 1,
      killed: false,
    });
    const failed = createKeyResolver({ exec: failedExec });
    await expect(failed.resolve("generic-command")).rejects.toThrow(
      "TypeSafe API key command failed"
    );
  });
});
