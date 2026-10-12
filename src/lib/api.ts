import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type RecordingState = {
  revision: number;
  status: "idle" | "recording" | "paused" | "stopped";
  meeting_id: string | null;
  source: string | null;
  error: string | null;
};
export type Meeting = {
  id: string;
  title: string;
  started_at: string;
  ended_at: string | null;
  status: "recording" | "paused" | "stopped" | "interrupted";
  source: "simulation" | "fixture" | "desktop" | "note";
  capture_error: string | null;
};
export type Segment = {
  speaker: "You" | "Others";
  start_ms: number;
  end_ms: number;
  text: string;
};
export type MeetingDetail = {
  meeting: Meeting;
  user_markdown: string;
  notes_revision: number;
  segments: Segment[];
  summary: string | null;
  summary_provider: string | null;
  summary_model: string | null;
  tracks: Array<{
    kind: string;
    path: string;
    device_name: string;
    sample_rate: number;
    frames: number;
    dropped_frames: number;
    finalized: boolean;
    /** WAV size on disk; null if the file is missing. */
    size_bytes: number | null;
  }>;
  summary_template: string | null;
};
export type AudioDevice = { id: string; name: string };
export type AudioDevices = {
  capture_supported: boolean;
  microphones: AudioDevice[];
  outputs: AudioDevice[];
};
export type AudioHealth = {
  error: string | null;
  tracks: Array<{
    kind: string;
    frames: number;
    dropped_frames: number;
    gaps: number;
    peak: number;
    callback_age_ms: number;
  }>;
};
export type Settings = {
  vault_folder: string | null;
  pause_shortcut: string;
  microphone_id: string | null;
  output_id: string | null;
  merge_model: string | null;
  export: ExportOptions;
};
export type ExportOptions = {
  transcript: boolean;
  summary: boolean;
  filename: "title" | "date_title";
};
export type MergeModel = {
  model: string;
  display_name: string | null;
  available: boolean;
  unavailable_reason: string | null;
};
export type SttStatus = {
  engine: boolean;
  model: boolean;
  vad: boolean;
  installed: boolean;
  missing_bytes: number;
  supported: boolean;
};
export type SttProgress = {
  stage: string;
  downloaded: number;
  total: number;
};
export type ExportResult = { path: string; created_copy: boolean };
export type SearchHit = {
  meeting_id: string;
  kind: "title" | "notes" | "transcript" | "summary";
  snippet: string;
};
/** Versioned template ids; must match `merge::Template` serde names in Rust. */
export type SummaryTemplate = "general-v1" | "standup-v1" | "one-to-one-v1";
export type SummaryVersion = {
  id: number;
  provider: string;
  model: string;
  /** Stored template id; older rows may hold "summary-v1" or "fixture". */
  template: string;
  markdown: string;
};

export const api = {
  isDesktop: isTauri,
  listMeetings: () => invoke<Meeting[]>("list_meetings"),
  getMeeting: (id: string) => invoke<MeetingDetail>("get_meeting", { id }),
  getRecordingState: () => invoke<RecordingState>("get_recording_state"),
  start: (title: string) =>
    invoke<RecordingState>("start_recording", {
      title,
      simulation: true,
      consent: false,
      devices: null,
    }),
  startCapture: (
    title: string,
    consent: boolean,
    devices: { microphoneId: string; outputId: string },
  ) =>
    invoke<RecordingState>("start_recording", {
      title,
      simulation: false,
      consent,
      devices,
    }),
  listDevices: () => invoke<AudioDevices>("list_audio_devices"),
  pause: () => invoke<RecordingState>("pause_recording"),
  resume: () => invoke<RecordingState>("resume_recording"),
  stop: () => invoke<RecordingState>("stop_recording"),
  createFixture: () => invoke<string>("create_fixture_meeting"),
  saveNotes: (id: string, markdown: string, expectedRevision: number) =>
    invoke<number>("save_notes", { id, markdown, expectedRevision }),
  getStartupWarning: () => invoke<string | null>("get_startup_warning"),
  getSettings: () => invoke<Settings>("get_settings"),
  mergeKeyStatus: () => invoke<boolean>("merge_key_status"),
  importMergeKey: () => invoke<boolean>("import_merge_key"),
  deleteMergeKey: () => invoke<boolean>("delete_merge_key"),
  listMergeModels: () => invoke<MergeModel[]>("list_merge_models"),
  saveMergeModel: (model: string) =>
    invoke<Settings>("save_merge_model", { model }),
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttInstall: () => invoke<SttStatus>("stt_install"),
  transcribeMeeting: (id: string) => invoke<void>("transcribe_meeting", { id }),
  generateSummary: (
    id: string,
    consent: boolean,
    template: SummaryTemplate,
    requests: number,
  ) => invoke<void>("generate_summary", { id, consent, template, requests }),
  saveSettings: (pauseShortcut: string) =>
    invoke<Settings>("save_settings", { pauseShortcut }),
  chooseVaultFolder: () => invoke<Settings>("choose_vault_folder"),
  exportMeeting: (id: string) => invoke<ExportResult>("export_meeting", { id }),
  close: () => invoke<void>("close_application"),
  onRecordingState: (callback: (state: RecordingState) => void) =>
    listen<RecordingState>("recording_state", (event) =>
      callback(event.payload),
    ),
  onSttProgress: (callback: (progress: SttProgress) => void) =>
    listen<SttProgress>("stt_progress", (event) => callback(event.payload)),
  onMeetingUpdated: (callback: () => void) =>
    listen("meeting_updated", callback),
  onCloseRequested: (callback: () => void) => listen("request_close", callback),
  onAudioHealth: (callback: (health: AudioHealth) => void) =>
    listen<AudioHealth>("audio_health", (event) => callback(event.payload)),
  onError: (callback: (message: string) => void) =>
    listen<string>("backend_error", (event) => callback(event.payload)),
  createNote: (title: string) => invoke<string>("create_note", { title }),
  audioUsage: () => invoke<number>("audio_usage"),
  deleteAudio: (id: string) => invoke<void>("delete_audio", { id }),
  deleteMeeting: (id: string) => invoke<void>("delete_meeting", { id }),
  searchMeetings: (query: string) =>
    invoke<SearchHit[]>("search_meetings", { query }),
  /** Number of Merge requests a summary would send; sends nothing. */
  planSummary: (id: string) => invoke<number>("plan_summary", { id }),
  listSummaries: (id: string) =>
    invoke<SummaryVersion[]>("list_summaries", { id }),
  askMeeting: (id: string, question: string, consent: boolean) =>
    invoke<string>("ask_meeting", { id, question, consent }),
  renameMeeting: (id: string, title: string) =>
    invoke<string>("rename_meeting", { id, title }),
  saveExportOptions: (options: ExportOptions) =>
    invoke<Settings>("save_export_options", { options }),
  recoverAudio: (id: string) => invoke<void>("recover_audio", { id }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}
