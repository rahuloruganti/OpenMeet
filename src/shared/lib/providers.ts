import type { ProviderRole } from "../api/api";

/** A known API provider. Every one speaks the OpenAI chat format at `baseUrl`; the backend
 * adds the few provider-specific headers (see `domain/providers.py`). */
export type ProviderPreset = {
  id: string;
  /** Short label shown in the picker and used as the default connection name. */
  label: string;
  baseUrl: string;
  /** Tasks this provider can serve through its OpenAI-compatible API. */
  roles: ProviderRole[];
  /** Where the user creates a key; shown as a plain host, never opened by the app. */
  keyPage: string;
};

/** The "Custom" choice: any OpenAI-compatible API the user types in. */
export const CUSTOM_PROVIDER = "custom";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    roles: ["llm", "cloud_stt"],
    keyPage: "platform.openai.com",
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    baseUrl: "https://api.anthropic.com/v1",
    roles: ["llm"],
    keyPage: "console.anthropic.com",
  },
  {
    id: "gemini",
    label: "Gemini (Google)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    roles: ["llm"],
    keyPage: "aistudio.google.com",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    roles: ["llm"],
    keyPage: "console.mistral.ai",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    roles: ["llm", "cloud_stt"],
    keyPage: "console.groq.com",
  },
  {
    id: "xai",
    label: "Grok (xAI)",
    baseUrl: "https://api.x.ai/v1",
    roles: ["llm"],
    keyPage: "console.x.ai",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    roles: ["llm"],
    keyPage: "platform.deepseek.com",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    roles: ["llm"],
    keyPage: "openrouter.ai",
  },
];

/** Presets that can serve a task, in display order. */
export function presetsFor(role: ProviderRole): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.roles.includes(role));
}

export function presetById(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

const normal = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

/** The preset a saved base URL belongs to, or null for a custom API. */
export function presetForUrl(baseUrl: string): ProviderPreset | null {
  const value = normal(baseUrl);
  return (
    PROVIDER_PRESETS.find((preset) => normal(preset.baseUrl) === value) ?? null
  );
}

/** A connection name that is not taken yet: "OpenAI", then "OpenAI 2", "OpenAI 3", ... */
export function freeName(label: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let n = 2; ; n += 1) {
    const candidate = `${label} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
