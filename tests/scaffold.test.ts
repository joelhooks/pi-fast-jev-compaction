import { describe, expect, it } from "vitest";

import fastJevCompaction from "../extensions/pi-fast-jev-compaction.ts";

describe("package scaffold", () => {
  it("exports a Pi extension factory", () => {
    expect(fastJevCompaction).toBeTypeOf("function");
  });
});
