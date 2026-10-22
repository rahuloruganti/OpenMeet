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
  /** Why automatic processing was skipped for this recording, if it was. */
  processing_notice?: string | null;
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
  configuration_revision: number;
  scope:
    | { kind: "live_only"; speech: SessionDestination }
    | {
        kind: "final";
        live: boolean;
        speech: SessionDestination;
        summary: {
          destination: SessionDestination;
          template: SummaryTemplate;
          /** Saved personal instructions frozen at recording start; omitted when empty. */
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
  tags: string[];
};
export type Segment = {
  speaker: "You" | "Others";
  timing:
    { kind: "timed"; start_ms: number; end_ms: number } | { kind: "untimed" };
  text: string;
};
export type QuestionTurn = {
  id: number;
  question: string;
  answer: string;
  provider: string;
  model: string;
};
export type QuestionThread = { id: number; turns: QuestionTurn[] };
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
  /** The transcript or speaker names changed after the latest summary was made. */
  summary_stale: boolean;
  speaker_names: SpeakerNames;
  /** Aligned by index with `segments`. */
  segment_meta: SegmentMeta[];
  /** Earlier transcripts, newest first. */
  transcript_versions: TranscriptVersion[];
  /** Saved questions and answers, newest thread first, turns oldest first. */
  question_threads: QuestionThread[];
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
  recipes: Recipe[];
  /** "recording", "live", "final" or "both"; applied to every new recording. */
  processing_mode: string;
  processing_summary: string | null;
  /** The template the Enhance picker starts at. */
  summary_default: string;
  /** Opt-in: prompt when another app starts using the microphone. Never starts recording. */
  detection_enabled: boolean;
  /** Apps never to prompt about; `name` is empty for ones ignored before names were kept. */
  detection_ignored: MicApp[];
  /** First-run setup was finished or skipped. */
  setup_done: boolean;
};
/** An app using the microphone: a Windows privacy-store key or a macOS bundle identifier. */
export type MicApp = { id: string; name: string };
/** A saved question prompt; `id` is `recipe-<uuid>`. */
export type Recipe = { id: string; name: string; prompt: string };
/** A saved answer over several meetings; `meeting_ids` are in the order sent (M1 first). */
export type LibraryAnswer = {
  id: number;
  question: string;
  answer: string;
  provider: string;
  model: string;
  meeting_ids: string[];
};
/** `original_text` holds the engine's text once the user edited a segment. */
export type SegmentMeta = { id: number; original_text: string | null };
export type TranscriptVersion = {
  id: number;
  provider: string | null;
  model: string | null;
  edited: boolean;
  segment_count: number;
};
/** Display names for the "You" (microphone) and "Others" (system audio) labels. */
export type SpeakerNames = { you: string | null; others: string | null };
/** "Rahul (You)" when named, otherwise the stored label; matches Rust `SpeakerNames::label`. */
export const speakerLabel = (names: SpeakerNames, speaker: string) => {
  const name =
    speaker === "You" ? names.you : speaker === "Others" ? names.others : null;
  return name ? `${name} (${speaker})` : speaker;
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
export type TranscriptFormat = "txt" | "srt" | "vtt";
export type ExportOptions = {
  transcript: boolean;
  summary: boolean;
  filename: "title" | "date_title";
  /** Extra transcript files written beside the Markdown snapshot. */
  transcript_formats: TranscriptFormat[];
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
/** A known AI or speech server answering on this machine. */
export type LocalServer = {
  name: string;
  base_url: string;
  kind: "chat" | "speech" | "both";
  /** It answered but wants an API key (Unsloth Studio does). */
  needs_key: boolean;
  models: ProviderModel[];
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
/** What a repository's file names say it holds; `other` is not downloadable. */
export type HubKind = "whisper_ggml" | "sherpa_onnx" | "other";
export type HubModel = { id: string; license: string | null; kind: HubKind };
export type HubFile = {
  repo_id: string;
  revision: string;
  filename: string;
  size: number;
  sha256: string;
  license: string | null;
  model_id: string | null;
};
export type SherpaLayout = "transducer" | "moonshine" | "single_model";
/** One complete sherpa-onnx folder; every file carries its LFS size and SHA-256. */
export type HubFolder = {
  repo_id: string;
  revision: string;
  folder: string;
  layout: SherpaLayout;
  license: string | null;
  files: HubFile[];
};
export type HubListing = { files: HubFile[]; folders: HubFolder[] };
export type ModelLibraryProgress = { downloaded: number; total: number };
export type ProviderModel = { id: string };
export type KeyStatus = "present" | "missing" | "unavailable";
export type KeyChange =
  { kind: "keep" } | { kind: "replace"; key: string } | { kind: "remove" };
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
export type ExportResult = {
  path: string;
  created_copy: boolean;
  transcript_paths: string[];
};
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
  /** The transcript or speaker names changed after this version was made. */
  stale: boolean;
};

export const api = {
  isDesktop: isTauri,
  listMeetings: () => invoke<Meeting[]>("list_meetings"),
  getMeeting: (id: string) => invoke<MeetingDetail>("get_meeting", { id }),
  getRecordingState: () => invoke<RecordingState>("get_recording_state"),
  /** Starts capture; automatic processing follows the saved default. */
  startCapture: (
    title: string,
    devices: { microphoneId: string; outputId: string },
  ) => invoke<RecordingState>("start_recording", { title, devices }),
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
  /** Retries failed or interrupted automatic processing with the current settings. */
  retrySessionProcessing: (id: string) =>
    invoke<SessionProcessingSnapshot>("retry_session_processing", { id }),
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
    invoke<HubListing>("list_hf_files", { repoId }),
  downloadHfModel: (file: HubFile) =>
    invoke<{ path: string; model_id: string | null }>("download_hf_model", {
      file,
    }),
  downloadHfFolder: (folder: HubFolder) =>
    invoke<{ path: string; files: number }>("download_hf_folder", { folder }),
  cancelModelDownload: () => invoke<void>("cancel_model_download"),
  /** Apps holding the microphone, reported when the stable list changes while detection is on. */
  onMicrophoneApps: (callback: (apps: MicApp[]) => void) =>
    listen<MicApp[]>("microphone_apps", (event) => callback(event.payload)),
  saveDetection: (enabled: boolean) =>
    invoke<Settings>("save_detection", { enabled }),
  setDetectionIgnored: (appId: string, name: string, ignored: boolean) =>
    invoke<Settings>("set_detection_ignored", { appId, name, ignored }),
  detectionSupported: () => invoke<boolean>("detection_supported"),
  /** Flashes the taskbar entry; never shows or focuses the window. */
  requestAttention: () => invoke<void>("request_attention"),
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
  transcribeMeeting: (id: string) => invoke<void>("transcribe_meeting", { id }),
  /** `template` is a built-in `SummaryTemplate` or a `CustomTemplate` id. */
  generateSummary: (id: string, template: string) =>
    invoke<void>("generate_summary", { id, template }),
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
  listSummaries: (id: string) =>
    invoke<SummaryVersion[]>("list_summaries", { id }),
  /** Saves an edit of `baseId` as the newest version; refused if `expectedLatestId` is stale. */
  /** `baseText` is the text the edit started from; a changed segment is refused. */
  editSegment: (
    meetingId: string,
    segmentId: number,
    baseText: string,
    text: string,
  ) => invoke<void>("edit_segment", { meetingId, segmentId, baseText, text }),
  getTranscriptVersion: (meetingId: string, versionId: number) =>
    invoke<Segment[]>("get_transcript_version", { meetingId, versionId }),
  /** Empty names clear back to "You"/"Others". */
  saveSpeakerNames: (
    meetingId: string,
    you: string | null,
    others: string | null,
  ) => invoke<SpeakerNames>("save_speaker_names", { meetingId, you, others }),
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
  /** Saves and returns the thread the answer joined. `threadId` continues a saved
   * thread, sending its earlier turns; null starts a new one. */
  askMeeting: (id: string, question: string, threadId: number | null) =>
    invoke<QuestionThread>("ask_meeting", { id, question, threadId }),
  /** One request over 1 to 20 meetings, in this order; the answer is saved and returned. */
  askLibrary: (meetingIds: string[], question: string) =>
    invoke<LibraryAnswer>("ask_library", { meetingIds, question }),
  /** Saved library answers, newest first. */
  listLibraryAnswers: () => invoke<LibraryAnswer[]>("list_library_answers"),
  /** Returns the remaining answers. */
  deleteLibraryAnswer: (id: number) =>
    invoke<LibraryAnswer[]>("delete_library_answer", { id }),
  /** Sends only the selected text and request; the result is returned, never stored. */
  rewriteText: (text: string, request: string) =>
    invoke<string>("rewrite_text", { text, request }),
  /** Creates a recipe when `id` is null; otherwise edits it. */
  saveRecipe: (id: string | null, name: string, prompt: string) =>
    invoke<Settings>("save_recipe", { id, name, prompt }),
  deleteRecipe: (id: string) => invoke<Settings>("delete_recipe", { id }),
  /** Returns the remaining threads. */
  deleteQuestionThread: (meetingId: string, threadId: number) =>
    invoke<QuestionThread[]>("delete_question_thread", { meetingId, threadId }),
  renameMeeting: (id: string, title: string) =>
    invoke<string>("rename_meeting", { id, title }),
  setMeetingTags: (meetingId: string, tags: string[]) =>
    invoke<string[]>("set_meeting_tags", { meetingId, tags }),
  saveExportOptions: (options: ExportOptions) =>
    invoke<Settings>("save_export_options", { options }),
  /** Probes known local server ports on 127.0.0.1 only; sends just GET /models. */
  detectLocalServers: () => invoke<LocalServer[]>("detect_local_servers"),
  saveSetupDone: (done: boolean) =>
    invoke<Settings>("save_setup_done", { done }),
  saveProcessingDefault: (mode: string, summary: string | null) =>
    invoke<Settings>("save_processing_default", { mode, summary }),
  saveSummaryDefault: (template: string) =>
    invoke<Settings>("save_summary_default", { template }),
  saveDefaultDevices: (microphoneId: string, outputId: string) =>
    invoke<Settings>("save_default_devices", { microphoneId, outputId }),
  recoverAudio: (id: string) => invoke<void>("recover_audio", { id }),
};

/** The backend error code, e.g. "stt_cancelled", if the error carries one. */
export const errorCode = (error: unknown) =>
  (error as { code?: string } | null)?.code;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error)
    return String(error.message);
  return String(error);
}
