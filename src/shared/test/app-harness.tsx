import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { App } from "../../app/App";
import {
  api,
  type MeetingDetail,
  type Settings,
  type SessionProcessingPlan,
  type SessionProcessingSnapshot,
} from "../api/api";

// Shared fixtures and mock setup for the App test files. Not a test file: discovery uses *.test.tsx.
export const sample: MeetingDetail = {
  meeting: {
    id: "sample",
    title: "Sample sync",
    started_at: "2026-10-09T10:00:00Z",
    ended_at: null,
    status: "stopped",
    source: "fixture",
    capture_error: null,
    tags: [],
  },
  user_markdown: "Original notes",
  notes_revision: 0,
  summary: "A fictional summary.",
  summary_provider: "fixture",
  summary_model: "hand-written",
  segments: [],
  tracks: [],
  summary_template: "fixture",
  transcript_provider: null,
  transcript_model: null,
  action_items: [],
  summary_edited: false,
  summary_stale: false,
  speaker_names: { you: null, others: null },
  segment_meta: [],
  transcript_versions: [],
  question_threads: [],
};

export const textPlan = {
  base_url: "https://provider.example/v1",
  model: "test-chat",
};
export const sessionPlan: SessionProcessingPlan = {
  id: "session-plan",
  meeting_id: null,

  configuration_revision: 1,

  scope: {
    kind: "final",
    live: true,
    speech: { kind: "local_whisper", model: "small" },
    summary: {
      destination: {
        kind: "compatible_api",
        base_url: "https://summary.example/v1",
        model: "chat",
        connection_id: "chat",
        connection_revision: 1,
        assignment_revision: 1,
      },
      template: "general-v1",
    },
  },
  language: "auto",
  tracks: ["microphone", "system"],
  limits: {
    duration_seconds: 3600,
    post_stop_seconds: 14400,
    upload_bytes: 5000,
    requests: 20,
    text_bytes: 10000,
  },
};
export function sessionSnapshot(
  revision: number,
  stage: NonNullable<SessionProcessingSnapshot["workflow"]>["stage"] = "live",
): SessionProcessingSnapshot {
  return {
    meeting_id: "sample",
    revision,
    state: "prepared",
    plan: sessionPlan,
    started_at: 1,
    authorized_until: 4_000_000_000,
    workflow: {
      run_id: "run",
      attempt: 1,
      stage,
      error: null,
      live_incomplete: false,
      transcript_done: false,
      notes_revision: null,
      notes_barrier: null,
      requests_used: 0,
      upload_bytes_used: 0,
      text_bytes_used: 0,
      provisional: [],
    },
  };
}

export const initialSettings: Settings = {
  saved_connections: [],
  provider_assignments: { llm: null, cloud_stt: null },
  vault_folder: null,
  pause_shortcut: "CommandOrControl+Shift+Space",
  microphone_id: null,
  output_id: null,
  llm: null,
  cloud_stt: null,
  stt_mode: "local",
  export: {
    transcript: true,
    summary: true,
    filename: "title",
    transcript_formats: [],
  },
  stt_language: "auto",
  stt_prompt: "",
  stt_model: "small",
  stop_shortcut: null,
  summary_instructions: "",
  summary_templates: [],
  recipes: [],
  processing_mode: "recording",
  processing_summary: null,
  summary_default: "general-v1",
  detection_enabled: false,
  detection_ignored: [],
  setup_done: true,
  theme: "system",
  inspector_open: true,
};

export const notInstalled = {
  engine: false,
  model: false,
  vad: false,
  installed: false,
  missing_bytes: 496_000_000,
  supported: true,
  models: [
    { id: "base", size: 147_951_465, installed: false },
    { id: "small", size: 487_601_967, installed: false },
  ],
  languages: ["auto", "de", "en"],
};
export const installed = {
  engine: true,
  model: true,
  vad: true,
  installed: true,
  missing_bytes: 0,
  supported: true,
  models: [
    { id: "base", size: 147_951_465, installed: false },
    { id: "small", size: 487_601_967, installed: true },
  ],
  languages: ["auto", "de", "en"],
};

export async function chooseProcessing(mode: string, summary?: string) {
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
  // Automatic processing is a switch now; its mode and summary appear once it is on.
  const automation = screen.getByRole("switch", {
    name: "Automatic processing",
  });
  if (
    mode !== "recording" &&
    automation.getAttribute("aria-checked") === "false"
  )
    await userEvent.click(automation);
  if (mode !== "recording")
    await userEvent.selectOptions(
      screen.getByLabelText("When a recording stops"),
      mode,
    );
  if (summary)
    await userEvent.selectOptions(
      screen.getByLabelText("Automatic summary"),
      summary,
    );
  // Leaves focus out of a field, so Escape can close Settings.
  await userEvent.click(screen.getByRole("tab", { name: "Recording" }));
}

export function installDefaultMocks() {
  localStorage.removeItem("openmeet.automaticProcessing");
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(api.isDesktop).mockReturnValue(true);
  vi.mocked(api.getSessionProcessing).mockResolvedValue(null);
  vi.mocked(api.listMeetings).mockResolvedValue([sample.meeting]);
  vi.mocked(api.listLibraryAnswers).mockResolvedValue([]);
  vi.mocked(api.saveProcessingDefault).mockImplementation(
    async (mode, summary) => ({
      ...initialSettings,
      processing_mode: mode,
      processing_summary: summary,
    }),
  );
  // Default: no earlier data folder, so first-run setup opens on Transcription.
  vi.mocked(api.importStatus).mockResolvedValue({
    available: false,
    path: null,
    meetings: 0,
    audio_files: 0,
    bytes: 0,
    blocked_reason: "No earlier data folder was found.",
  });
  vi.mocked(api.saveUiPrefs).mockImplementation(
    async (theme, inspectorOpen) => ({
      ...initialSettings,
      theme,
      inspector_open: inspectorOpen,
    }),
  );
  vi.mocked(api.getMeeting).mockResolvedValue(sample);
  vi.mocked(api.getRecordingState).mockResolvedValue({
    revision: 0,
    status: "idle",
    meeting_id: null,
    source: null,
    error: null,
    recording_offset_ms: null,
  });
  vi.mocked(api.onModelLibraryProgress).mockResolvedValue(() => {});
  vi.mocked(api.apiConnectionKeyStatus).mockResolvedValue("present");
  vi.mocked(api.getSettings).mockResolvedValue(initialSettings);
  vi.mocked(api.dataFolder).mockResolvedValue({
    path: "C:/Users/Test/AppData/Roaming/OpenMeetPy",
  });
  vi.mocked(api.chooseVaultFolder).mockResolvedValue({
    ...initialSettings,
    vault_folder: "C:/notes",
  });
  vi.mocked(api.listDevices).mockResolvedValue({
    capture_supported: true,
    microphones: [{ id: "mic", name: "Microphone" }],
    outputs: [{ id: "out", name: "Speakers" }],
  });
  vi.mocked(api.getStartupWarning).mockResolvedValue(null);
  vi.mocked(api.saveNotes).mockResolvedValue(1);
  vi.mocked(api.providerKeyStatus).mockResolvedValue("missing");
  vi.mocked(api.sttStatus).mockResolvedValue(notInstalled);
  vi.mocked(api.audioUsage).mockResolvedValue(0);
  vi.mocked(api.detectionSupported).mockResolvedValue(true);
  vi.mocked(api.requestAttention).mockResolvedValue();
  vi.mocked(api.searchMeetings).mockResolvedValue([]);
  vi.mocked(api.listSummaries).mockResolvedValue([]);
  for (const method of [
    api.onRecordingState,
    api.onSessionProcessingChanged,
    api.onMeetingUpdated,
    api.onCloseRequested,
    api.onError,
    api.onAudioHealth,
    api.onSttProgress,
    api.onMicrophoneApps,
  ]) {
    vi.mocked(method).mockResolvedValue(vi.fn());
  }
}

export async function ready() {
  render(<App />);
  await screen.findByDisplayValue("Original notes");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Save notes now",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}
