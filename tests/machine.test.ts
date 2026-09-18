import { describe, expect, it } from "vitest";

import { CompactionLifecycle } from "../src/machine.ts";

describe("compaction lifecycle", () => {
  it("moves idle through deciding to each terminal outcome", () => {
    const lifecycle = new CompactionLifecycle(8000);
    expect(lifecycle.snapshot().value).toBe("idle");
    expect(lifecycle.begin(60_000, "proactive")).toBe(true);
    expect(lifecycle.isDeciding()).toBe(true);
    lifecycle.finish("applied");
    expect(lifecycle.snapshot().value).toBe("applied");
    expect(lifecycle.snapshot().context.lastRunTokens).toBe(60_000);

    expect(lifecycle.begin(70_000, "proactive")).toBe(true);
    lifecycle.finish("fallback");
    expect(lifecycle.snapshot().value).toBe("fallback");

    expect(lifecycle.begin(80_000, "compaction", true)).toBe(true);
    lifecycle.finish("failed");
    expect(lifecycle.snapshot().value).toBe("failed");
    lifecycle.stop();
  });

  it("blocks overlap and proactive runs inside the cooldown", () => {
    const lifecycle = new CompactionLifecycle(8000);
    expect(lifecycle.begin(50_000, "proactive")).toBe(true);
    expect(lifecycle.begin(60_000, "proactive")).toBe(false);
    lifecycle.finish("applied");
    expect(lifecycle.begin(57_999, "proactive")).toBe(false);
    expect(lifecycle.begin(58_000, "proactive")).toBe(true);
    lifecycle.abort();
    expect(lifecycle.snapshot().value).toBe("idle");
    lifecycle.stop();
  });
});
