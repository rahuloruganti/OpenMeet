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
export type SessionProcessingRequest =
  | { kind: "live_only" }
  | {
      kind: "final";
      live: boolean;
      summary: SummaryTemplate | null;
    };
export type SessionDestination =
  | { kind: "local_whisper"; model: string }
  | {
      kind: "compatible_api";
      base_url: string;
      model: string;
      connection_id: string;
      connection_revision: number;
      assignment_revision: number;
    };
export type SessionProcessingPlan = {
  id: string;
  meeting_id: string | null;
  fingerprint: string;
  configuration_revision: number;
  review_expires_at: number;
  scope:
    | { kind: "live_only"; speech: SessionDestination }
    | {
        kind: "final";
        live: boolean;
        speech: SessionDestination;
        summary: {
          destination: SessionDestination;
          template: SummaryTemplate;
          /** Saved personal instructions frozen at review; omitted when empty. */
          instructions?: string;
        } | null;
      };
  language: string;
  tracks: [string, string];
  limits: {
    duration_seconds: number;
    post_stop_seconds: number;
    upload_bytes: number;
    requests: number;
    text_bytes: number;
  };
};
export type SessionProcessingSnapshot = {
  meeting_id: string;
  revision: number;
  state: "prepared" | "consent_required" | "cancelled" | "interrupted";
  plan: SessionProcessingPlan;
  started_at: number;
  authorized_until: number;
  workflow: SessionWorkflow | null;
};
export type SessionWorkflow = {
  run_id: string;
  attempt: number;
  stage:
    | "live"
    | "finalizing_audio"
    | "transcribing"
    | "awaiting_notes"
    | "summarizing"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "consent_required";
  error: string | null;
  live_incomplete: boolean;
  transcript_done: boolean;
  notes_revision: number | null;
  notes_barrier: string | null;
  requests_used: number;
  upload_bytes_used: number;
  text_bytes_used: number;
  provisional: { id: string; chunk_id: number; segment: Segment }[];
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
  action_items: ActionItem[];
  /** The latest summary is a user edit, not unedited model output. */
  summary_edited: boolean;
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
  saved_connections: SavedConnection[];
  provider_assignments: Record<ProviderRole, ProviderAssignment | null>;
  llm: ProviderConfig | null;
  cloud_stt: ProviderConfig | null;
  stt_mode: "local" | "cloud";
  stt_language: string;
  stt_prompt: string;
  stt_model: string;
  stop_shortcut: string | null;
  export: ExportOptions;
  summary_instructions: string;
  summary_templates: CustomTemplate[];
};
/** Editable meeting task; `owner` and `due_date` are null when not established. */
export type ActionItem = {
  id: number;
  text: string;
  owner: string | null;
  due_date: string | null;
  done: boolean;
  source: "manual" | "summary";
  summary_id: number | null;
};
/** User-defined summary structure; `id` is `custom-<uuid>`. */
export type CustomTemplate = {
  id: string;
  name: string;
  instructions: string;
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
export type SavedConnection = {
  id: string;
  name: string;
  base_url: string;
  revision: number;
};
export type ProviderAssignment = {
  connection_id: string;
  model: string;
  revision: number;
};
export type ProviderSelection =
  | { kind: "unassigned" }
  | { kind: "assigned"; connection_id: string; model: string };
export type LocalModel = {
  path: string;
  format: "whisper" | "gguf" | "unknown";
  size: number;
  model_id: string | null;
};
export type ModelScan = {
  models: LocalModel[];
  folders: { path: string; status: string }[];
  truncated: boolean;
};
export type HubModel = { id: string; license: string | null };
export type HubFile = {
  repo_id: string;
  revision: string;
  filename: string;
  size: number;
  sha256: string;
  license: string | null;
  model_id: string | null;
};
export type ModelLibraryProgress = { downloaded: number; total: number };
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
  /** Version the user edited this one from; null for generated output. */
  edited_from: number | null;
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
    processingConfirmation: string | null = null,
  ) =>
    invoke<RecordingState>("start_recording", {
      title,
      consent,
      devices,
      processingConfirmation,
    }),
  prepareSessionProcessing: (request: SessionProcessingRequest) =>
    invoke<SessionProcessingPlan>("prepare_session_processing", { request }),
  getSessionProcessing: (id: string) =>
    invoke<SessionProcessingSnapshot | null>("get_session_processing", { id }),
  acknowledgeProcessingNotes: (
    id: string,
    runId: string,
    notesBarrier: string,
    expectedNotesRevision: number,
  ) =>
    invoke<SessionProcessingSnapshot>("acknowledge_processing_notes", {
      id,
      runId,
      notesBarrier,
      expectedNotesRevision,
    }),
  prepareSessionRetry: (id: string) =>
    invoke<SessionProcessingPlan>("prepare_session_retry", { id }),
  retrySessionProcessing: (id: string, confirmation: string) =>
    invoke<SessionProcessingSnapshot>("retry_session_processing", {
      id,
      confirmation,
    }),
  cancelSessionProcessing: (id: string, expectedRevision: number) =>
    invoke<SessionProcessingSnapshot>("cancel_session_processing", {
      id,
      expectedRevision,
    }),
  onSessionProcessingChanged: (
    callback: (snapshot: SessionProcessingSnapshot) => void,
  ) =>
    listen<SessionProcessingSnapshot>("session_processing_changed", (event) =>
      callback(event.payload),
    ),
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
  saveApiConnection: (args: {
    id: string | null;
    name: string;
    baseUrl: string;
    keyChange: KeyChange;
    expectedRevision: number | null;
  }) => invoke<Settings>("save_api_connection", args),
  deleteApiConnection: (id: string, expectedRevision: number) =>
    invoke<Settings>("delete_api_connection", { id, expectedRevision }),
  apiConnectionKeyStatus: (id: string) =>
    invoke<KeyStatus>("api_connection_key_status", { id }),
  listApiConnectionModels: (id: string, expectedRevision: number) =>
    invoke<ProviderModel[]>("list_api_connection_models", {
      id,
      expectedRevision,
    }),
  saveProviderAssignment: (
    role: ProviderRole,
    selection: ProviderSelection,
    expectedRevision: number | null,
  ) =>
    invoke<Settings>("save_provider_assignment", {
      role,
      selection,
      expectedRevision,
    }),
  chooseModelFolder: () => invoke<string | null>("choose_model_folder"),
  scanLocalModels: (folder: string | null) =>
    invoke<ModelScan>("scan_local_models", { folder }),
  importLocalModel: (path: string) =>
    invoke<{ model_id: string }>("import_local_model", { path }),
  searchHfModels: (query: string) =>
    invoke<HubModel[]>("search_hf_models", { query }),
  listHfFiles: (repoId: string) =>
    invoke<HubFile[]>("list_hf_files", { repoId }),
  downloadHfModel: (file: HubFile) =>
    invoke<{ path: string; model_id: string | null }>("download_hf_model", {
      file,
    }),
  cancelModelDownload: () => invoke<void>("cancel_model_download"),
  onModelLibraryProgress: (
    callback: (progress: ModelLibraryProgress) => void,
  ) =>
    listen<ModelLibraryProgress>("model_library_progress", (event) =>
      callback(event.payload),
    ),
  saveSttMode: (mode: Settings["stt_mode"]) =>
    invoke<Settings>("save_stt_mode", { mode }),
  sttStatus: () => invoke<SttStatus>("stt_status"),
  sttInstall: () => invoke<SttStatus>("stt_install"),
  planTranscription: (id: string) =>
    invoke<ProcessingPlan>("plan_transcription", { id }),
  transcribeMeeting: (id: string, confirmation: string | null) =>
    invoke<void>("transcribe_meeting", { id, confirmation }),
  /** `template` is a built-in `SummaryTemplate` or a `CustomTemplate` id. */
  generateSummary: (id: string, template: string, confirmation: string) =>
    invoke<void>("generate_summary", { id, template, confirmation }),
  saveSummaryInstructions: (instructions: string) =>
    invoke<Settings>("save_summary_instructions", { instructions }),
  saveSummaryTemplate: (
    id: string | null,
    name: string,
    instructions: string,
  ) => invoke<Settings>("save_summary_template", { id, name, instructions }),
  deleteSummaryTemplate: (id: string) =>
    invoke<Settings>("delete_summary_template", { id }),
  /** Creates a task when `itemId` is null; otherwise edits it. Returns the meeting's tasks. */
  saveActionItem: (
    meetingId: string,
    itemId: number | null,
    text: string,
    owner: string | null,
    dueDate: string | null,
    done: boolean,
  ) =>
    invoke<ActionItem[]>("save_action_item", {
      meetingId,
      itemId,
      text,
      owner,
      dueDate,
      done,
    }),
  deleteActionItem: (meetingId: string, itemId: number) =>
    invoke<ActionItem[]>("delete_action_item", { meetingId, itemId }),
  importActionItems: (meetingId: string, summaryId: number) =>
    invoke<ActionItem[]>("import_action_items", { meetingId, summaryId }),
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
  planSummary: (id: string, template: string) =>
    invoke<ProcessingPlan>("plan_summary", { id, template }),
  planQuestion: (id: string, question: string) =>
    invoke<ProcessingPlan>("plan_question", { id, question }),
  listSummaries: (id: string) =>
    invoke<SummaryVersion[]>("list_summaries", { id }),
  /** Saves an edit of `baseId` as the newest version; refused if `expectedLatestId` is stale. */
  saveSummaryEdit: (
    meetingId: string,
    baseId: number,
    expectedLatestId: number,
    markdown: string,
  ) =>
    invoke<void>("save_summary_edit", {
      meetingId,
      baseId,
      expectedLatestId,
      markdown,
    }),
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
