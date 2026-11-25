/**
 * API-generator execution path for rebuildup.textgen (ADR-0018).
 *
 * Opt-in HTTP text generation against OpenAI, Anthropic, or any
 * OpenAI-compatible endpoint. The API key is resolved per invocation
 * (env var or config-dir key file), used only as a request credential,
 * and never appears in output, errors, state, or logs. `fetch` is
 * injectable for tests.
 */

import type { ApiGeneratorConfig } from "./config";
import { resolveApiKey } from "./config";
import { TextgenError } from "./model";
import type { BuiltPrompt } from "./prompts";

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Endpoint policy (ADR-0018): https everywhere; plain http is allowed
 * only for loopback hosts (local OpenAI-compatible servers such as
 * Ollama/LM Studio). Anything else is rejected before a key is read.
 */
export function endpointAllowed(endpoint: string): { ok: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "endpoint is not a valid URL" };
  }
  if (url.protocol === "https:") return { ok: true };
  if (url.protocol === "http:") {
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return { ok: true };
    }
    return { ok: false, reason: "plain http is only allowed for loopback endpoints" };
  }
  return { ok: false, reason: `unsupported URL scheme "${url.protocol}"` };
}

/** Build the request URL for a generator kind from its base endpoint. */
export function apiRequestUrl(generator: ApiGeneratorConfig): string {
  const base = generator.endpoint.replace(/\/+$/, "");
  if (generator.kind === "anthropic") {
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }
  // openai / openai-compatible
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

interface ApiRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function buildRequest(
  generator: ApiGeneratorConfig,
  model: string,
  prompt: BuiltPrompt,
  apiKey: string,
): ApiRequest {
  const url = apiRequestUrl(generator);
  if (generator.kind === "anthropic") {
    return {
      url,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: generator.maxTokens ?? 4096,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      }),
    };
  }
  return {
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Extract generated text from a provider response; null when absent. */
export function extractApiText(generator: ApiGeneratorConfig, body: unknown): string | null {
  const root = asRecord(body);
  if (generator.kind === "anthropic") {
    const content = Array.isArray(root.content) ? root.content : [];
    const texts = content
      .map((part) => asRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => asRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

export interface ApiExecParams {
  generator: ApiGeneratorConfig;
  model: string;
  prompt: BuiltPrompt;
  timeoutMs?: number | undefined;
  fetchImpl?: FetchImpl | undefined;
  configDir?: string | undefined;
}

export interface ApiExecResult {
  text: string;
  model: string;
  endpoint: string;
}

/**
 * Run one generation against an API generator. Throws TextgenError with
 * codes: `provider_endpoint_insecure`, `no_credential`,
 * `api_request_failed`, `api_bad_response`. Error details never contain
 * the API key or response bodies.
 */
export async function executeApiPrompt(params: ApiExecParams): Promise<ApiExecResult> {
  const { generator } = params;
  const allowed = endpointAllowed(generator.endpoint);
  if (!allowed.ok) {
    throw new TextgenError(
      "provider_endpoint_insecure",
      "policy",
      `api generator "${generator.id}" endpoint rejected: ${allowed.reason}`,
      { generator: generator.id },
    );
  }

  const apiKey = await resolveApiKey(generator, params.configDir);
  if (apiKey === null) {
    throw new TextgenError(
      "no_credential",
      "unavailable",
      `api generator "${generator.id}" has no credential: set env ${generator.keyEnv ?? "(default key env)"} or <config>/keys/${generator.id}.key`,
      { generator: generator.id },
    );
  }

  const request = buildRequest(generator, params.model, params.prompt, apiKey);
  const fetchImpl = params.fetchImpl ?? fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TextgenError(
      "api_request_failed",
      "provider_error",
      `api generator "${generator.id}" request failed: ${message.slice(0, 200)}`,
      { generator: generator.id },
    );
  }

  if (response.status < 200 || response.status >= 300) {
    // Status only — provider error bodies can echo request context.
    throw new TextgenError(
      "api_request_failed",
      "provider_error",
      `api generator "${generator.id}" returned HTTP ${response.status}`,
      { generator: generator.id, status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TextgenError(
      "api_bad_response",
      "provider_error",
      `api generator "${generator.id}" returned a non-JSON response`,
      { generator: generator.id },
    );
  }

  const text = extractApiText(generator, body);
  if (text === null || text.trim() === "") {
    throw new TextgenError(
      "api_bad_response",
      "provider_error",
      `api generator "${generator.id}" response contained no text`,
      { generator: generator.id },
    );
  }

  return { text, model: params.model, endpoint: generator.endpoint };
}
