import type { Settings, SummaryTemplate } from "../../shared/api/api";

export type ProcessingMode = "recording" | "live" | "final" | "both";
export type ProcessingChoice = {
  mode: ProcessingMode;
  summary: SummaryTemplate | null;
};

export const modeLabels: Record<ProcessingMode, string> = {
  recording: "Recording only",
  live: "Live transcription only",
  final: "Final transcription after stop",
  both: "Live and final transcription",
};
const modes = Object.keys(modeLabels) as ProcessingMode[];

/** Workflow stages and session states; unknown values fall back to their words. */
const stageLabels: Partial<Record<string, string>> = {
  prepared: "Ready",
  live: "Recording",
  finalizing_audio: "Finishing audio",
  transcribing: "Transcribing",
  awaiting_notes: "Waiting for your notes to save",
  summarizing: "Writing summary",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  needs_attention: "stopped because settings changed; retry when ready",
};
export const stageLabel = (stage: string) =>
  stageLabels[stage] ?? stage.replaceAll("_", " ");

/** Built-in summary templates in picker order. */
export const builtinTemplates: { id: SummaryTemplate; label: string }[] = [
  { id: "general-v1", label: "General" },
  { id: "standup-v1", label: "Stand-up" },
  { id: "one-to-one-v1", label: "One-to-one" },
];

function choice(mode: unknown, summary: unknown): ProcessingChoice {
  const chosen = modes.find((item) => item === mode) ?? "recording";
  return {
    mode: chosen,
    summary:
      chosen === "final" || chosen === "both"
        ? (builtinTemplates.find((item) => item.id === summary)?.id ?? null)
        : null,
  };
}

/** The saved default, applied to every new recording. */
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
