import { vi } from "vitest";

vi.stubGlobal(
  "fetch",
  vi.fn(async () => {
    throw new Error("Network access is disabled in the test suite");
  })
);
