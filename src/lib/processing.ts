import type { SummaryTemplate } from "./api";

export type ProcessingMode = "recording" | "live" | "final" | "both";
export type ProcessingChoice = {
  mode: ProcessingMode;
  summary: SummaryTemplate | null;
};

const KEY = "openmeet.automaticProcessing";
const modes: ProcessingMode[] = ["recording", "live", "final", "both"];
const templates: SummaryTemplate[] = [
  "general-v1",
  "standup-v1",
  "one-to-one-v1",
];

/** A per-device choice only. Starting a recording still needs a reviewed, confirmed plan. */
export function loadProcessing(): ProcessingChoice {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
      mode?: unknown;
      summary?: unknown;
    } | null;
    const mode = modes.find((item) => item === value?.mode) ?? "recording";
    const summary = templates.find((item) => item === value?.summary) ?? null;
    return {
      mode,
      summary: mode === "final" || mode === "both" ? summary : null,
    };
  } catch {
    return { mode: "recording", summary: null };
  }
}

export function saveProcessing(choice: ProcessingChoice) {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    // Storage may be unavailable; the choice then lasts for this session only.
  }
}
