/**
 * Ported from tamaratran/fast-jev-compaction (MIT).
 * Copyright (c) 2025. See LICENSE for the upstream notice.
 */

import type { JevQuestions, JevResponse, JevState } from "./types.ts";

export const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";

export interface JevRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export function buildJevRequest(
  params: { apiKey: string; model?: string; baseUrl?: string },
  state: JevState,
  questions: JevQuestions
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Jev returned malformed JSON");
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    throw new Error("Jev response is missing answers");
  }
  return parsed as unknown as JevResponse;
}

export function noulAnswer(
  answers: Record<string, unknown>,
  name: string
): number {
  const answer = answers[name];
  if (
    !isRecord(answer) ||
    answer.type !== "noul" ||
    typeof answer.noul !== "number" ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  if (answer.noul < 0 || answer.noul > 1) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class JevClient {
  readonly #options: JevClientOptions;
  readonly #fetcher: typeof fetch;

  constructor(options: JevClientOptions) {
    this.#options = options;
    this.#fetcher = options.fetch ?? fetch;
  }

  async ask(
    state: JevState,
    questions: JevQuestions,
    signal?: AbortSignal
  ): Promise<JevResponse> {
    if (!this.#options.apiKey)
      throw new Error("TypeSafe API key is not configured");
    const request = buildJevRequest(this.#options, state, questions);
    const response = await this.#fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    });
    return parseJevResponse(
      response.status,
      response.ok,
      await response.text()
    );
  }
}
