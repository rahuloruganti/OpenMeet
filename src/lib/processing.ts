import type { Settings, SummaryTemplate } from "./api";

export type ProcessingMode = "recording" | "live" | "final" | "both";
export type ProcessingChoice = {
  mode: ProcessingMode;
  summary: SummaryTemplate | null;
};

const modes: ProcessingMode[] = ["recording", "live", "final", "both"];
const templates: SummaryTemplate[] = [
  "general-v1",
  "standup-v1",
  "one-to-one-v1",
];

function choice(mode: unknown, summary: unknown): ProcessingChoice {
  const chosen = modes.find((item) => item === mode) ?? "recording";
  return {
    mode: chosen,
    summary:
      chosen === "final" || chosen === "both"
        ? (templates.find((item) => item === summary) ?? null)
        : null,
  };
}

/** The saved default. Starting a recording still needs a reviewed, confirmed plan. */
export const processingDefault = (settings: Settings | null) =>
  choice(settings?.processing_mode, settings?.processing_summary);

const LEGACY_KEY = "openmeet.automaticProcessing";

/** The default that earlier versions kept in webview storage, if any. */
export function legacyProcessing(): ProcessingChoice | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as { mode?: unknown; summary?: unknown };
    return choice(value?.mode, value?.summary);
  } catch {
    return null;
  }
}

/** Call once the database holds the default, so the old value is never lost. */
export function forgetLegacyProcessing() {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Unavailable storage has nothing to forget.
  }
}
