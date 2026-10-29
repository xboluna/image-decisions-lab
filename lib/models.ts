/** Decision models on OpenRouter's Decisions API. maxImages is the most images one request may carry, when capped. */
export const DECISION_MODELS: { id: string; label: string; maxImages?: number; note?: string }[] = [
  { id: "perplexity/pplx-decider-v1.2", label: "Perplexity Decider v1.2", maxImages: 8, note: "Default" },
  { id: "openai/gpt-6-luna-decisions", label: "GPT-6 Luna Decisions" },
  { id: "perplexity/pplx-decider-v1.1-27b", label: "Perplexity Decider v1.1 27B", maxImages: 8 },
  { id: "liquid/d1", label: "Liquid D1", maxImages: 8 },
  { id: "inception/mercury-decide", label: "Inception Mercury Decide", maxImages: 16 },
  { id: "cloudflare/clef", label: "Cloudflare Clef", maxImages: 4 },
  { id: "cloudflare/clef-omni", label: "Cloudflare Clef Omni", maxImages: 4 },
];

export const DEFAULT_MODEL = DECISION_MODELS[0].id;

export function modelInfo(id: string) {
  return DECISION_MODELS.find((m) => m.id === id);
}
