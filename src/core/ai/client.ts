import { statusError } from "../http.ts";
import type { HttpTransport } from "../http.ts";
import * as PromptMetrics from "./promptMetrics.ts";

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}

export interface LlmClient {
  chat(system: string, user: string, maxOutputTokens?: number): Promise<string>;
  chatWithUsage(
    system: string,
    user: string,
    maxOutputTokens?: number,
  ): Promise<[string, LlmUsage]>;
  /**
   * Multimodal completion over one image; returns the assistant content.
   * Optional so text-only fakes stay valid; callers must treat an absent
   * method as "this client does not support vision" (Android's LlmClient
   * default throws for it).
   */
  describeImage?(prompt: string, image: { mime: string; dataUrl: string }): Promise<string>;
}

/** One content part of a multimodal chat message (OpenAI-compatible shape). */
type ChatContentPart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "text"; text: string };

interface ChatPayload {
  model: string;
  messages: { role: string; content: string | ChatContentPart[] }[];
  temperature?: number;
  max_tokens: number;
}

/**
 * Minimal OpenAI-compatible client (chat completions + model listing). The API
 * key is only sent as a Bearer header — never logged or included in errors.
 * Timeouts use the shared PromptMetrics rule: 180s normally, 900s only when
 * the estimated cold prefill exceeds 180s.
 */
export class AiClient implements LlmClient {
  private readonly root: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly http: HttpTransport;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    temperature = 0.7,
    maxTokens = 2048,
    http: HttpTransport,
  ) {
    this.root = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.http = http;
  }

  private chatUrl(): string {
    return this.root + "/chat/completions";
  }

  async testConnection(): Promise<void> {
    const resp = await this.post({
      model: this.model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("chat/completions", resp.status, resp.body);
    }
  }

  async listModels(): Promise<string[]> {
    const resp = await this.http.request({
      method: "GET",
      url: this.root + "/models",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMs: 60_000,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("models", resp.status, resp.body);
    }
    const parsed = JSON.parse(resp.body) as { data?: { id?: string }[] };
    return [...new Set((parsed.data ?? []).map((m) => m.id ?? "").filter(Boolean))].sort();
  }

  chat(system: string, user: string, maxOutputTokens?: number): Promise<string> {
    return this.chatWithUsage(system, user, maxOutputTokens).then(([content]) => content);
  }

  async describeImage(prompt: string, image: { mime: string; dataUrl: string }): Promise<string> {
    const payload: ChatPayload = {
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image.dataUrl } },
            { type: "text", text: prompt },
          ],
        },
      ],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    const timeoutMs = PromptMetrics.BASE_FIRST_BYTE_SECONDS * 1000;

    let resp = await this.post(payload, timeoutMs);
    // Some providers reject any temperature other than their fixed default.
    if (resp.status === 400 && payload.temperature !== undefined &&
        resp.body.toLowerCase().includes("temperature")) {
      const { temperature: _drop, ...stripped } = payload;
      resp = await this.post(stripped, timeoutMs);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("chat/completions", resp.status, resp.body);
    }
    return parseContent(resp.body);
  }

  async chatWithUsage(
    system: string,
    user: string,
    maxOutputTokens?: number,
  ): Promise<[string, LlmUsage]> {
    const payload: ChatPayload = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: this.temperature,
      max_tokens: maxOutputTokens ?? this.maxTokens,
    };
    const timeoutMs =
      (PromptMetrics.needsExtendedTimeout(system, user)
        ? PromptMetrics.EXTENDED_FIRST_BYTE_SECONDS
        : PromptMetrics.BASE_FIRST_BYTE_SECONDS) * 1000;

    let resp = await this.post(payload, timeoutMs);
    // Some providers reject any temperature other than their fixed default.
    if (resp.status === 400 && payload.temperature !== undefined &&
        resp.body.toLowerCase().includes("temperature")) {
      const { temperature: _drop, ...stripped } = payload;
      resp = await this.post(stripped, timeoutMs);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw statusError("chat/completions", resp.status, resp.body);
    }
    return [parseContent(resp.body), parseUsage(resp.body)];
  }

  private post(payload: ChatPayload | Omit<ChatPayload, "temperature">, timeoutMs?: number) {
    return this.http.request({
      method: "POST",
      url: this.chatUrl(),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs,
    });
  }
}

function parseContent(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("chat/completions: response was not JSON");
  }
  const choices = (parsed as { choices?: { message?: { content?: unknown } }[] }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("chat/completions: response had no assistant content");
  }
  return content;
}

function parseUsage(body: string): LlmUsage {
  try {
    const u = (JSON.parse(body) as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        prompt_cache_hit_tokens?: number;
      };
    }).usage;
    return {
      promptTokens: u?.prompt_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
      cachedPromptTokens:
        u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0,
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
  }
}
