import type { DecisionQuestion } from "./prompt";
import type { ContentPart, Usage } from "./types";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const KEY_URL = "https://openrouter.ai/api/v1/key";
const APP_TITLE = "Image Decisions Lab";

export type KeyInfo = {
  label: string;
  limit: number | null;
  limitRemaining: number | null;
  usage: number | null;
  isFreeTier: boolean;
};

/** Confirms the key works without spending anything: OpenRouter's key endpoint returns its label and spend cap. */
export async function checkKey(apiKey: string, signal?: AbortSignal): Promise<KeyInfo> {
  const response = await fetch(KEY_URL, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  const body = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { message?: string } };
  if (!response.ok || !body.data) {
    throw new Error(body.error?.message || (response.status === 401 ? "OpenRouter rejected this key." : `OpenRouter answered ${response.status}.`));
  }
  const d = body.data;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return { label: String(d.label ?? "key"), limit: num(d.limit), limitRemaining: num(d.limit_remaining), usage: num(d.usage), isFreeTier: !!d.is_free_tier };
}

export type DecisionResult = {
  ok: boolean;
  status: number;
  error?: string;
  answer?: Record<string, unknown>;
  body: Record<string, unknown>;
  usage: Usage;
  latencyMs: number;
};

function errorText(status: number, body: Record<string, unknown>): string {
  const err = body.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  if (typeof body.raw === "string") return body.raw.slice(0, 300);
  return status ? `HTTP ${status}` : "Network error";
}

const RETRY = new Set([0, 408, 429, 500, 502, 503, 504]);

/** One Decisions API call with retries on rate limits, timeouts and server errors. */
export async function decide(opts: {
  apiKey: string;
  model: string;
  state: ContentPart[];
  questionId: string;
  question: DecisionQuestion;
  signal?: AbortSignal;
  attempts?: number;
}): Promise<DecisionResult> {
  const attempts = opts.attempts ?? 4;
  let last: DecisionResult = { ok: false, status: 0, body: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, latencyMs: 0, error: "Not sent" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const started = performance.now();
    let status = 0;
    let body: Record<string, unknown> = {};
    try {
      const response = await fetch(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", "X-Title": APP_TITLE },
        body: JSON.stringify({ model: opts.model, state: opts.state, questions: { [opts.questionId]: opts.question } }),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      });
      status = response.status;
      const text = await response.text();
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      body = { error: err instanceof Error ? err.message : String(err) };
    }
    const latencyMs = Math.round(performance.now() - started);
    const usageRaw = (body.usage ?? {}) as Record<string, unknown>;
    const usage = { inputTokens: Number(usageRaw.input_tokens ?? 0), outputTokens: Number(usageRaw.output_tokens ?? 0), costUsd: Number(usageRaw.cost ?? 0) };
    const answers = body.answers as Record<string, unknown> | undefined;
    const answer = answers?.[opts.questionId] as Record<string, unknown> | undefined;
    if (status === 200 && answer) return { ok: true, status, answer, body, usage, latencyMs };
    last = { ok: false, status, body, usage, latencyMs, error: status === 200 ? "The response had no answer for the question." : errorText(status, body) };
    if (!RETRY.has(status)) break;
    await new Promise((r) => setTimeout(r, 2 ** attempt * 600 + Math.random() * 300));
  }
  return last;
}

/** Class probabilities from a Decisions API answer. Boolean questions give P(yes) as "noul". */
export function answerProbabilities(answer: Record<string, unknown>, targetType: "boolean" | "categorical", classes: string[]): Record<string, number> | null {
  if (targetType === "boolean") {
    const p = answer.noul;
    if (typeof p !== "number" || !Number.isFinite(p)) return null;
    return { true: p, false: 1 - p };
  }
  const probs = answer.probabilities as Record<string, unknown> | undefined;
  if (!probs || typeof probs !== "object") {
    return typeof answer.choice === "string" ? Object.fromEntries(classes.map((c) => [c, c === answer.choice ? 1 : 0])) : null;
  }
  return Object.fromEntries(classes.map((c) => [c, typeof probs[c] === "number" ? (probs[c] as number) : 0]));
}
