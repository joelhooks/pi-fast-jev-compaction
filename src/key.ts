import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface KeyResolver {
  resolve: (
    apiKeyCommand: string | undefined,
    signal?: AbortSignal
  ) => Promise<string>;
  clear: () => void;
}

export function createKeyResolver(pi: Pick<ExtensionAPI, "exec">): KeyResolver {
  let cached: string | undefined;

  return {
    async resolve(apiKeyCommand, signal) {
      if (cached) return cached;
      const fromEnvironment = process.env.TYPESAFE_API_KEY?.trim();
      if (fromEnvironment) {
        cached = fromEnvironment;
        return cached;
      }
      if (!apiKeyCommand) throw new Error("TypeSafe API key is not configured");
      const result = await pi.exec("sh", ["-lc", apiKeyCommand], {
        signal,
        timeout: 15_000,
      });
      const value = result.stdout.trim();
      if (result.code !== 0 || !value)
        throw new Error("TypeSafe API key command failed");
      cached = value;
      return cached;
    },
    clear() {
      cached = undefined;
    },
  };
}
