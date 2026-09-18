import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { DEFAULT_MODEL, SYSTEM_ONE_URL } from "./core/request.ts";

export interface FastJevConfig {
  enabled: boolean;
  apiKeyCommand?: string;
  model: string;
  baseUrl: string;
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
  compactAtPercent: number;
  minReductionRatio: number;
  cooldownTokens: number;
}

export const DEFAULT_CONFIG: FastJevConfig = {
  enabled: true,
  model: DEFAULT_MODEL,
  baseUrl: SYSTEM_ONE_URL,
  goal: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  cooldownTokens: 8000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function finiteInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

export function parseConfig(
  value: unknown,
  base: FastJevConfig = DEFAULT_CONFIG
): FastJevConfig {
  if (!isRecord(value)) return { ...base };
  const command =
    typeof value.apiKeyCommand === "string" && value.apiKeyCommand.trim()
      ? value.apiKeyCommand.trim()
      : undefined;
  const apiKeyCommand = command ?? base.apiKeyCommand;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : base.enabled,
    ...(apiKeyCommand ? { apiKeyCommand } : {}),
    model: nonEmptyString(value.model, base.model),
    baseUrl: nonEmptyString(value.baseUrl, base.baseUrl),
    goal: typeof value.goal === "string" ? value.goal : base.goal,
    keepThreshold: finiteInRange(value.keepThreshold, base.keepThreshold, 0, 1),
    preserveRecentMessages: Math.floor(
      finiteInRange(
        value.preserveRecentMessages,
        base.preserveRecentMessages,
        0,
        10_000
      )
    ),
    maxStateTokens: Math.floor(
      finiteInRange(value.maxStateTokens, base.maxStateTokens, 1, 1_000_000)
    ),
    maxRequestTokens: Math.floor(
      finiteInRange(value.maxRequestTokens, base.maxRequestTokens, 1, 1_000_000)
    ),
    truncateHeadChars: Math.floor(
      finiteInRange(
        value.truncateHeadChars,
        base.truncateHeadChars,
        0,
        1_000_000
      )
    ),
    compactAtPercent: finiteInRange(
      value.compactAtPercent,
      base.compactAtPercent,
      1,
      100
    ),
    minReductionRatio: finiteInRange(
      value.minReductionRatio,
      base.minReductionRatio,
      0,
      1
    ),
    cooldownTokens: Math.floor(
      finiteInRange(value.cooldownTokens, base.cooldownTokens, 0, 1_000_000)
    ),
  };
}

export async function loadConfig(
  cwd: string,
  projectTrusted: boolean
): Promise<FastJevConfig> {
  const globalSettings = await readSettings(
    join(getAgentDir(), "settings.json")
  );
  let config = parseConfig(globalSettings.fastJevCompaction);
  if (projectTrusted) {
    const projectSettings = await readSettings(
      join(cwd, CONFIG_DIR_NAME, "settings.json")
    );
    config = parseConfig(projectSettings.fastJevCompaction, config);
  }
  return config;
}
