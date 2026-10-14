import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function isLocalBase(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return (
      host === "localhost" ||
      host === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

export type RecordingState = {
  revision: number;
  status: "idle" | "recording" | "paused" | "stopped";
  meeting_id: string | null;
  source: string | null;
  error: string | null;
  /** Audio written so far (paused time excluded); null without real capture. */
  recording_offset_ms: number | null;
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
  timing:
    { kind: "timed"; start_ms: number; end_ms: number } | { kind: "untimed" };
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
  transcript_provider: string | null;
  transcript_model: string | null;
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
  llm: ProviderConfig | null;
  cloud_stt: ProviderConfig | null;
  stt_mode: "local" | "cloud";
  stt_language: string;
  stt_prompt: string;
  stt_model: string;
  stop_shortcut: string | null;
  export: ExportOptions;
};
export type ExportOptions = {
  transcript: boolean;
  summary: boolean;
  filename: "title" | "date_title";
};
export type ProviderRole = "llm" | "cloud_stt";
export type ProviderConfig = {
  base_url: string;
  model: string | null;
  revision: number;
};
export type ProviderModel = { id: string };
export type KeyStatus = "present" | "missing" | "unavailable";
export type KeyChange =
  { kind: "keep" } | { kind: "replace"; key: string } | { kind: "remove" };
export type ProcessingPlan = {
  fingerprint: string;
  base_url: string;
  model: string;
  requests: number;
  audio_bytes: number;
  tracks: string[];
};
export type SttStatus = {
  engine: boolean;
  model: boolean;
  vad: boolean;
  installed: boolean;
  missing_bytes: number;
  supported: boolean;
  models: Array<{ id: string; size: number; installed: boolean }>;
  languages: string[];
};
export type SttDownloadProgress = {
  stage: "engine" | "model" | "vad";
  downloaded: number;
  total: number;
};
export type SttTranscribeProgress = {
  stage: "transcribing";
  track: string;
  percent: number;
};
export type SttProgress = SttDownloadProgress | SttTranscribeProgress;
export type ExportResult = { path: string; created_copy: boolean };
export type SearchHit = {
  meeting_id: string;
  kind: "title" | "notes" | "transcript" | "summary";
  snippet: string;
};
/** Versioned template ids; must match `llm::Template` serde names in Rust. */
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
  startCapture: (
    title: string,
    consent: boolean,
    devices: { microphoneId: string; outputId: string },
  ) =>
    invoke<RecordingState>("start_recording", {
      title,
      consent,
      devices,
    }),
  listDevices: () => invoke<AudioDevices>("list_audio_devices"),
  pause: () => invoke<RecordingState>("pause_recording"),
  resume: () => invoke<RecordingState>("resume_recording"),
  stop: () => invoke<RecordingState>("stop_recording"),
  saveNotes: (id: string, markdown: string, expectedRevision: number) =>
    invoke<number>("save_notes", { id, markdown, expectedRevision }),
  getStartupWarning: () => invoke<string | null>("get_startup_warning"),
  getSettings: () => invoke<Settings>("get_settings"),
  providerKeyStatus: (role: ProviderRole) =>
    invoke<KeyStatus>("provider_key_status", { role }),
  saveProviderConnection: (
    role: ProviderRole,
    baseUrl: string,
    keyChange: KeyChange,
    expectedRevision: number | null,
  ) =>
    invoke<Settings>("save_provider_connection", {
      role,
      baseUrl,
      keyChange,
      expectedRevision,
    }),
  listProviderModels: (role: ProviderRole, expectedRevision: number) =>
    invoke<ProviderModel[]>("list_provider_models", { role, expectedRevision }),
  saveProviderModel: (
    role: ProviderRole,
    model: string,
    expectedRevision: number,
  ) =>
    invoke<Settings>("save_provider_model", { role, model, expectedRevision }),
  saveSttMode: (mode: Settings["stt_mode"]) =>
    invoke<Settings>("save_stt_mode", { mode }),
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttInstall: () => invoke<SttStatus>("stt_install"),
  planTranscription: (id: string) =>
    invoke<ProcessingPlan>("plan_transcription", { id }),
  transcribeMeeting: (id: string, confirmation: string | null) =>
    invoke<void>("transcribe_meeting", { id, confirmation }),
  generateSummary: (
    id: string,
    template: SummaryTemplate,
    confirmation: string,
  ) => invoke<void>("generate_summary", { id, template, confirmation }),
  saveSettings: (pauseShortcut: string, stopShortcut: string | null) =>
    invoke<Settings>("save_settings", { pauseShortcut, stopShortcut }),
  chooseVaultFolder: () => invoke<Settings>("choose_vault_folder"),
  exportMeeting: (id: string) => invoke<ExportResult>("export_meeting", { id }),
  close: () => invoke<void>("close_application"),
  cancelTranscription: () => invoke<boolean>("cancel_transcription"),
  saveSttSettings: (language: string, prompt: string, model: string) =>
    invoke<Settings>("save_stt_settings", { language, prompt, model }),
  /** Maps a transcript (session) time to a position in that track's file, in ms. */
  audioPosition: (id: string, kind: string, sessionMs: number) =>
    invoke<number>("audio_position", { id, kind, sessionMs }),
  /** Asset-protocol URL; the backend scope only serves the app-data audio folder. */
  audioSrc: (path: string) => convertFileSrc(path),
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
  /** Plans a summary without submitting meeting content. */
  planSummary: (id: string, template: SummaryTemplate) =>
    invoke<ProcessingPlan>("plan_summary", { id, template }),
  planQuestion: (id: string, question: string) =>
    invoke<ProcessingPlan>("plan_question", { id, question }),
  listSummaries: (id: string) =>
    invoke<SummaryVersion[]>("list_summaries", { id }),
  askMeeting: (id: string, question: string, confirmation: string) =>
    invoke<string>("ask_meeting", { id, question, confirmation }),
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
